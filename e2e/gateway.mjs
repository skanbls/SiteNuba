// Banc d'essai local : imite la partie de Supabase dont l'appli a besoin.
//   /auth/v1/*  comptes en clair dans auth.users (base de test uniquement)
//   /rest/v1/*  relayé vers PostgREST, qui applique les vraies règles RLS des migrations
//   /storage/v1/* fichiers gardés en mémoire ; l'accès passe par les vraies règles RLS de storage.objects
// Ne sert qu'aux tests de bout en bout. Jamais en production.
import crypto from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

const SECRET = process.env.JWT_SECRET;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims) => {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
  return `${head}.${crypto.createHmac('sha256', SECRET).update(head).digest('base64url')}`;
};

if (process.argv.includes('--anon-key')) {
  console.log(sign({ role: 'anon', iss: 'nuba-e2e', exp: 4102444800 }));
  process.exit(0);
}

const PGRST = process.env.PGRST_URL || 'http://127.0.0.1:3999';
const db = new pg.Pool({ connectionString: process.env.DB_URL });
const refreshTokens = new Map();

const verify = (token) => {
  const [h, p, s] = String(token || '').split('.');
  if (!s || crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  return c.exp && c.exp < Date.now() / 1000 ? null : c;
};
const userJson = (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
  email_confirmed_at: u.email_confirmed_at, confirmed_at: u.email_confirmed_at,
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.raw_user_meta_data,
  identities: [{ id: u.id, user_id: u.id, provider: 'email', identity_data: { email: u.email } }],
  created_at: u.created_at, updated_at: u.created_at,
});
const sessionJson = (u) => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const refresh_token = crypto.randomUUID();
  refreshTokens.set(refresh_token, u.id);
  return {
    access_token: sign({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, exp }),
    token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token, user: userJson(u),
  };
};
const bearer = (req) => verify((req.headers.authorization || '').replace(/^Bearer /i, ''));
const userById = async (id) => (await db.query('select * from auth.users where id = $1', [id])).rows[0];

const CORS = {
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,apikey,content-type,prefer,range,accept,accept-profile,content-profile,x-client-info,x-supabase-api-version,x-nuba-ticket,x-upsert,cache-control',
  'access-control-expose-headers': 'content-range,content-profile',
  'access-control-max-age': '600',
};

async function auth(req, url, body) {
  const path = url.pathname.replace('/auth/v1', '');
  const data = body.length ? JSON.parse(body.toString()) : {};
  if (path === '/signup' && req.method === 'POST') {
    const email = String(data.email || '').toLowerCase();
    if ((await db.query('select 1 from auth.users where email = $1', [email])).rowCount) return [422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' }];
    const { rows } = await db.query(
      'insert into auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data) values ($1, $2, now(), $3) returning *',
      [email, data.password, JSON.stringify(data.data || {})]);
    return [200, sessionJson(rows[0])];
  }
  if (path === '/token' && req.method === 'POST') {
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      const u = await userById(refreshTokens.get(data.refresh_token));
      return u ? [200, sessionJson(u)] : [400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' }];
    }
    const { rows } = await db.query('select * from auth.users where email = $1 and encrypted_password = $2', [String(data.email || '').toLowerCase(), data.password]);
    return rows[0] ? [200, sessionJson(rows[0])] : [400, { error: 'invalid_grant', error_code: 'invalid_credentials', error_description: 'Invalid login credentials', msg: 'Invalid login credentials' }];
  }
  if (path === '/user') {
    const c = bearer(req);
    const u = c?.sub && (await userById(c.sub));
    if (!u) return [401, { code: 401, msg: 'invalid JWT' }];
    if (req.method === 'PUT' && data.password) await db.query('update auth.users set encrypted_password = $1 where id = $2', [data.password, u.id]);
    return [200, userJson(u)];
  }
  if (path === '/logout') return [204, null];
  if (path === '/recover') return [200, {}];
  return [404, { msg: 'not found' }];
}

// ---------- Stockage de fichiers (imitation de Supabase Storage) ----------
const files = new Map();      // « bucket/chemin » → { mime, data }
const signed = new Map();     // jeton → « bucket/chemin »
/** Exécute une requête avec le rôle et l'identité de la personne : les règles RLS s'appliquent. */
async function asUser(req, sql, params) {
  const c = bearer(req);
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${c?.role === 'authenticated' ? 'authenticated' : 'anon'}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(c || {})]);
    const r = await client.query(sql, params);
    await client.query('commit');
    return r;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
async function storage(req, url, body) {
  const path = decodeURIComponent(url.pathname.replace('/storage/v1', ''));
  let m;
  if ((m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(path)) && req.method === 'POST') {
    const { rowCount } = await asUser(req, 'select 1 from storage.objects where bucket_id = $1 and name = $2', [m[1], m[2]]);
    if (!rowCount || !files.has(`${m[1]}/${m[2]}`)) return [400, { statusCode: '404', error: 'not_found', message: 'Object not found' }];
    const token = crypto.randomUUID();
    signed.set(token, `${m[1]}/${m[2]}`);
    return [200, { signedURL: `/object/sign/${m[1]}/${m[2]}?token=${token}` }];
  }
  if ((m = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(path)) && req.method === 'GET') {
    const f = signed.get(url.searchParams.get('token')) === `${m[1]}/${m[2]}` && files.get(`${m[1]}/${m[2]}`);
    return f ? [200, f.data, f.mime] : [400, { error: 'invalid_token' }];
  }
  if ((m = /^\/object\/([^/]+)\/(.+)$/.exec(path)) && req.method === 'POST') {
    try {
      await asUser(req, 'insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)', [m[1], m[2], bearer(req)?.sub ?? null]);
    } catch (e) {
      return [403, { statusCode: '403', error: 'Unauthorized', message: String(e.message) }];
    }
    files.set(`${m[1]}/${m[2]}`, { mime: req.headers['content-type'] || 'application/octet-stream', data: body });
    return [200, { Key: `${m[1]}/${m[2]}`, Id: crypto.randomUUID() }];
  }
  if ((m = /^\/object\/([^/]+)$/.exec(path)) && req.method === 'DELETE') {
    const names = JSON.parse(body.toString() || '{}').prefixes || [];
    const { rows } = await asUser(req, 'delete from storage.objects where bucket_id = $1 and name = any($2) returning name', [m[1], names]);
    for (const r of rows) files.delete(`${m[1]}/${r.name}`);
    return [200, rows.map((r) => ({ name: r.name }))];
  }
  return [404, { message: 'not found' }];
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*';
  const cors = { ...CORS, 'access-control-allow-origin': origin, vary: 'Origin' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname.startsWith('/auth/v1')) {
      const [status, json] = await auth(req, url, body);
      res.writeHead(status, { ...cors, 'content-type': 'application/json' });
      return res.end(json === null ? undefined : JSON.stringify(json));
    }
    if (url.pathname.startsWith('/storage/v1')) {
      const [status, out, mime] = await storage(req, url, body);
      res.writeHead(status, { ...cors, 'content-type': mime || 'application/json' });
      return res.end(Buffer.isBuffer(out) ? out : JSON.stringify(out));
    }
    if (url.pathname.startsWith('/rest/v1')) {
      const headers = {};
      for (const k of ['authorization', 'content-type', 'prefer', 'range', 'accept', 'accept-profile', 'content-profile', 'x-nuba-ticket']) if (req.headers[k]) headers[k] = req.headers[k];
      const r = await fetch(PGRST + url.pathname.replace('/rest/v1', '') + url.search, { method: req.method, headers, body: body.length ? body : undefined });
      const out = { ...cors };
      for (const k of ['content-type', 'content-range', 'content-profile']) if (r.headers.get(k)) out[k] = r.headers.get(k);
      res.writeHead(r.status, out);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    res.writeHead(404, cors).end();
  } catch (e) {
    console.error(e);
    res.writeHead(500, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ msg: String(e) }));
  }
}).listen(Number(process.env.PORT || 54321), '127.0.0.1', () => console.log('gateway prêt'));
