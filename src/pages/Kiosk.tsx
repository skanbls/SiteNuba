import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CodeView, useRollingCode } from '../components/RollingCode';
import { Field, Spinner } from '../components/ui';
import { frError, supabase } from '../lib/supabase';
import { buildLabel } from '../lib/update';
import type { CodeInfo } from '../lib/types';

const KEY = 'nuba.borne';

const read = () => {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
};
const write = (t: string) => {
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch {
    /* stockage refusé : la borne marchera jusqu'à la fermeture de la page */
  }
};

/** Cet appareil est relié à une borne (un iPad fixe, en général) : l'appli s'ouvre alors directement sur la borne. */
export const hasKiosk = () => !!read();

/** Cet appareil n'est plus une borne. */
export const unlinkKiosk = () => write('');

/** iPhone ou iPad dans Safari, et non dans l'appli installée sur l'écran d'accueil. */
function inIosBrowser(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  return ios && nav.standalone !== true && !window.matchMedia('(display-mode: standalone)').matches;
}

/** Écran de la borne : l'appareil fixe qui affiche le QR code de pointage. Aucun compte requis, seulement le jeton de la borne. */
export default function Kiosk() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [token, setToken] = useState(read);
  const [dead, setDead] = useState(false);

  const link = useCallback((t: string) => {
    write(t);
    setToken(t);
    setDead(false);
  }, []);

  // Borne désactivée par le gérant : l'appareil l'oublie, pour ne plus s'ouvrir dessus.
  const onDead = useCallback(() => {
    write('');
    setDead(true);
  }, []);

  // Arrivée par le lien de la borne : le jeton reste sur l'appareil et disparaît de la barre d'adresse.
  useEffect(() => {
    const t = params.get('t');
    if (!t) return;
    link(t);
    nav('/borne', { replace: true });
  }, [params, nav, link]);

  useEffect(() => {
    document.title = 'Borne de pointage · Nuba Gestion';
  }, []);

  const leave = () => nav('/', { replace: true });

  return (
    <div className="full">
      {dead ? (
        <div className="card">
          <h1>Borne désactivée</h1>
          <p>Cette borne n'est plus valable : le gérant l'a désactivée.</p>
          <div className="acts">
            <button type="button" className="btn pri" onClick={() => link('')}>Relier à une nouvelle borne</button>
            <button type="button" className="btn" onClick={leave}>Ouvrir l'appli</button>
          </div>
        </div>
      ) : token ? <Live token={token} onDead={onDead} onLeave={leave} /> : <Pair onToken={link} onLeave={leave} />}
    </div>
  );
}

/* ---------- Borne en service ---------- */
function Live({ token, onDead, onLeave }: { token: string; onDead: () => void; onLeave: () => void }) {
  const [clock, setClock] = useState(new Date());

  // Garde l'écran allumé tant que la borne est affichée.
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    const ask = () => {
      if (document.visibilityState === 'visible') wl?.request('screen').then((l) => (lock = l)).catch(() => {});
    };
    ask();
    document.addEventListener('visibilitychange', ask);
    const tick = window.setInterval(() => setClock(new Date()), 10_000);
    return () => {
      document.removeEventListener('visibilitychange', ask);
      window.clearInterval(tick);
      void lock?.release();
    };
  }, []);

  const fetcher = useCallback(async () => {
    const { data, error } = await supabase.rpc('kiosk_code', { p_token: token });
    if (error) throw error;
    return data as CodeInfo | null;
  }, [token]);
  const { info, left, state } = useRollingCode(fetcher);

  useEffect(() => {
    if (state === 'revoked') onDead();
  }, [state, onDead]);

  return (
    <div className="borne">
      <p className="clock">{clock.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}{info ? ` · ${info.site_name}` : ''}</p>
      <h1>Scanne ce code pour pointer</h1>
      <CodeView info={info} left={left} />
      {state === 'offline' && <p className="pill bad">Connexion perdue, nouvel essai en cours</p>}
      <p className="note center">Ouvre la pointeuse dans l'appli Nuba, puis scanne ce QR code ou saisis les 6 chiffres. Le code change toutes les 30 secondes.</p>
      {inIosBrowser() && (
        <p className="note center">
          Pour retrouver la borne sur l'écran d'accueil de cet iPad, relie-la depuis l'appli installée : écran de connexion, « Cet appareil est une borne de pointage », puis le code donné dans Réglages. La borne ouverte dans Safari n'est pas reprise par l'appli installée.
        </p>
      )}
      <button type="button" className="link" onClick={onLeave}>Ouvrir l'appli sur cet appareil</button>
      <p className="sub">Version du {buildLabel()}</p>
    </div>
  );
}

/* ---------- Relier cet appareil à une borne ---------- */
const PAIR_ERROR: Record<string, string> = {
  code: 'Code refusé ou expiré. Il est valable 10 minutes : demandes-en un nouveau dans Réglages.',
  too_many: "Trop de codes refusés. Réessaie dans 10 minutes.",
};

function Pair({ onToken, onLeave }: { onToken: (t: string) => void; onLeave: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setErr('Le code a 6 chiffres.');
    setBusy(true);
    setErr('');
    const { data, error } = await supabase.rpc('claim_kiosk', { p_code: code });
    setBusy(false);
    if (error) return setErr(frError(error));
    const r = data as { ok: boolean; token?: string; error?: string };
    if (r.ok && r.token) return onToken(r.token);
    setErr(PAIR_ERROR[r.error ?? ''] ?? 'Liaison impossible.');
  }

  return (
    <div className="card">
      <div>
        <h1>Relier cette borne</h1>
        <p className="sub">Cet appareil affichera le QR code de pointage à chaque ouverture de l'appli.</p>
      </div>
      <ol className="note" style={{ paddingLeft: 18, display: 'grid', gap: 4 }}>
        <li>Sur ton téléphone, ouvre Réglages puis « Ajouter une borne » (ou « Relier un appareil » sur une borne existante).</li>
        <li>Tape ici le code à 6 chiffres qui s'affiche.</li>
      </ol>
      <form className="form" onSubmit={submit}>
        <Field label="Code de liaison">
          <input className="in code" id="pair-code" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={code} autoFocus
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="acts">
          <button className="btn pri" disabled={busy || code.length !== 6}>{busy ? <Spinner /> : 'Relier'}</button>
          <button type="button" className="btn" onClick={onLeave}>Retour à la connexion</button>
        </div>
      </form>
    </div>
  );
}
