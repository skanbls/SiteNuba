-- Imitation minimale de Supabase pour tester les migrations sur un PostgreSQL local.
-- Ne jamais exécuter sur le vrai projet Supabase.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit password 'authenticator'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Cas le plus strict pour les tables : aucun droit par défaut, les migrations doivent tout accorder.
-- Cas le plus permissif pour les fonctions (exécutables par tous par défaut, comme dans PostgreSQL) :
-- les migrations doivent retirer ce qui ne doit pas être appelable.
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Imitation de pg_net et du coffre (Vault) : les requêtes « envoyées » s'accumulent dans net.sent,
-- et les réponses du service d'envoi s'écrivent à la main dans net._http_response.
create schema net;
create table net.sent (id bigint generated always as identity primary key, url text, body jsonb, headers jsonb);
create table net._http_response (
  id bigint, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz not null default now()
);
create function net.http_post(
  url text, body jsonb default '{}', params jsonb default '{}',
  headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000
) returns bigint language plpgsql security definer as $$
declare v bigint;
begin
  insert into net.sent (url, body, headers) values ($1, $2, $4) returning id into v;
  return v;
end $$;
create schema vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
