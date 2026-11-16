import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CodeView, useRollingCode } from '../components/RollingCode';
import { supabase } from '../lib/supabase';
import type { CodeInfo } from '../lib/types';

const KEY = 'nuba.borne';
const read = () => {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
};

/** Écran de la borne : l'iPad fixe qui affiche le QR code de pointage. Aucun compte requis, seulement le lien de la borne. */
export default function Kiosk() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [token, setToken] = useState(read);
  const [clock, setClock] = useState(new Date());

  // Le jeton arrive une fois par le lien, puis reste sur l'appareil et disparaît de la barre d'adresse.
  useEffect(() => {
    const t = params.get('t');
    if (!t) return;
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* stockage refusé : la borne marchera jusqu'à la fermeture de la page */
    }
    setToken(t);
    nav('/borne', { replace: true });
  }, [params, nav]);

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

  useEffect(() => {
    document.title = 'Borne de pointage · Nuba Gestion';
  }, []);

  return (
    <div className="full">
      {token ? <Live fetcher={fetcher} clock={clock} /> : (
        <div className="card">
          <h1>Borne non reliée</h1>
          <p>Cet appareil n'est pas encore une borne de pointage.</p>
          <p className="note">Dans l'appli, le gérant ouvre Réglages, ajoute une borne, puis ouvre sur cet appareil le lien qui s'affiche.</p>
        </div>
      )}
    </div>
  );
}

function Live({ fetcher, clock }: { fetcher: () => Promise<CodeInfo | null>; clock: Date }) {
  const { info, left, state } = useRollingCode(fetcher);
  if (state === 'revoked')
    return (
      <div className="card">
        <h1>Borne désactivée</h1>
        <p>Le lien de cette borne n'est plus valable.</p>
        <p className="note">Le gérant peut en créer une nouvelle dans Réglages, puis ouvrir son lien sur cet appareil.</p>
      </div>
    );
  return (
    <div className="borne">
      <p className="clock">{clock.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}{info ? ` · ${info.site_name}` : ''}</p>
      <h1>Scanne ce code pour pointer</h1>
      <CodeView info={info} left={left} />
      {state === 'offline' && <p className="pill bad">Connexion perdue, nouvel essai en cours</p>}
      <p className="note center">Ouvre la pointeuse dans l'appli Nuba, puis scanne ce QR code ou saisis les 6 chiffres. Le code change toutes les 30 secondes.</p>
    </div>
  );
}
