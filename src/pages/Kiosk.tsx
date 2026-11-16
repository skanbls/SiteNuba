import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CodeView, useRollingCode } from '../components/RollingCode';
import { Field, Spinner } from '../components/ui';
import { useQrCamera } from '../components/useQrCamera';
import { parseKioskLink } from '../lib/punch';
import { frError, supabase } from '../lib/supabase';
import type { CodeInfo } from '../lib/types';

const KEY = 'nuba.borne';
const PAUSED = 'nuba.borne.pause';

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
const setPaused = (on: boolean) => {
  try {
    if (on) sessionStorage.setItem(PAUSED, '1');
    else sessionStorage.removeItem(PAUSED);
  } catch {
    /* sans importance */
  }
};

/** Cet appareil est relié à une borne (un iPad fixe, en général). */
export const hasKiosk = () => !!read();

/**
 * Vrai si l'appli doit s'ouvrir directement sur la borne : l'appareil est relié,
 * et personne n'a choisi « Ouvrir l'appli » depuis la borne pendant cette utilisation.
 */
export function opensOnKiosk(): boolean {
  try {
    return hasKiosk() && !sessionStorage.getItem(PAUSED);
  } catch {
    return hasKiosk();
  }
}

/** Écran de la borne : l'appareil fixe qui affiche le QR code de pointage. Aucun compte requis, seulement le jeton de la borne. */
export default function Kiosk() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [token, setToken] = useState(read);

  const link = useCallback((t: string) => {
    write(t);
    setToken(t);
  }, []);

  // Arrivée par le lien de la borne : le jeton reste sur l'appareil et disparaît de la barre d'adresse.
  useEffect(() => {
    setPaused(false);
    const t = params.get('t');
    if (!t) return;
    link(t);
    nav('/borne', { replace: true });
  }, [params, nav, link]);

  useEffect(() => {
    document.title = 'Borne de pointage · Nuba Gestion';
  }, []);

  const leave = () => {
    setPaused(true);
    nav('/', { replace: true });
  };

  return (
    <div className="full">
      {token ? <Live token={token} onUnlink={() => link('')} onLeave={leave} /> : <Pair onToken={link} onLeave={leave} />}
    </div>
  );
}

/* ---------- Borne en service ---------- */
function Live({ token, onUnlink, onLeave }: { token: string; onUnlink: () => void; onLeave: () => void }) {
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

  if (state === 'revoked')
    return (
      <div className="card">
        <h1>Borne désactivée</h1>
        <p>Cette borne n'est plus valable : le gérant l'a désactivée.</p>
        <div className="acts">
          <button type="button" className="btn pri" onClick={onUnlink}>Relier à une nouvelle borne</button>
          <button type="button" className="btn" onClick={onLeave}>Ouvrir l'appli</button>
        </div>
      </div>
    );

  return (
    <div className="borne">
      <p className="clock">{clock.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}{info ? ` · ${info.site_name}` : ''}</p>
      <h1>Scanne ce code pour pointer</h1>
      <CodeView info={info} left={left} />
      {state === 'offline' && <p className="pill bad">Connexion perdue, nouvel essai en cours</p>}
      <p className="note center">Ouvre la pointeuse dans l'appli Nuba, puis scanne ce QR code ou saisis les 6 chiffres. Le code change toutes les 30 secondes.</p>
      <button type="button" className="link" onClick={onLeave}>Ouvrir l'appli sur cet appareil</button>
    </div>
  );
}

/* ---------- Relier cet appareil à une borne ---------- */
function Pair({ onToken, onLeave }: { onToken: (t: string) => void; onLeave: () => void }) {
  const [camera, setCamera] = useState(true);
  const [pasted, setPasted] = useState('');
  const [err, setErr] = useState('');
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);

  const tryText = useCallback(
    async (text: string) => {
      if (busy.current) return;
      const t = parseKioskLink(text);
      if (!t) return setErr("Ce n'est pas le QR code d'une borne. Il s'affiche dans Réglages, juste après « Ajouter une borne ».");
      busy.current = true;
      setChecking(true);
      setErr('');
      try {
        const { data, error } = await supabase.rpc('kiosk_code', { p_token: t });
        if (error) throw error;
        if (data) return onToken(t);
        setErr("Cette borne n'est plus valable. Crées-en une nouvelle dans Réglages.");
      } catch (e) {
        setErr(frError(e));
      }
      setChecking(false);
      window.setTimeout(() => (busy.current = false), 2500);
    },
    [onToken],
  );

  const video = useQrCamera(camera, (t) => void tryText(t), () => setCamera(false), 'user');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void tryText(pasted);
  };

  return (
    <div className="card">
      <div>
        <h1>Relier cette borne</h1>
        <p className="sub">Cet appareil affichera le QR code de pointage dès l'ouverture de l'appli.</p>
      </div>
      <ol className="note" style={{ paddingLeft: 18, display: 'grid', gap: 4 }}>
        <li>Sur ton téléphone, ouvre Réglages puis « Ajouter une borne ».</li>
        <li>Présente le QR code qui s'affiche devant la caméra avant de cet appareil.</li>
      </ol>
      {camera ? <video ref={video} className="video" playsInline muted aria-label="Caméra" /> : <p className="note">Caméra indisponible ou refusée : colle le lien de la borne ci-dessous.</p>}
      <form className="form" onSubmit={submit}>
        <Field label="Ou colle ici le lien de la borne">
          <input className="in" id="pair-link" value={pasted} onChange={(e) => setPasted(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="acts">
          <button className="btn pri" disabled={checking || !pasted.trim()}>{checking ? <Spinner /> : 'Relier'}</button>
          <button type="button" className="btn" onClick={onLeave}>Retour à la connexion</button>
        </div>
      </form>
    </div>
  );
}
