import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { punchLink } from '../lib/punch';
import type { CodeInfo } from '../lib/types';
import { Spinner } from './ui';

export type CodeState = 'loading' | 'ok' | 'offline' | 'revoked';

/**
 * Va chercher le code en cours, puis le suivant dès qu'il expire.
 * `fetcher` doit être stable (useCallback) et renvoyer null si l'accès est révoqué.
 */
export function useRollingCode(fetcher: () => Promise<CodeInfo | null>) {
  const [info, setInfo] = useState<CodeInfo | null>(null);
  const [left, setLeft] = useState(0);
  const [state, setState] = useState<CodeState>('loading');

  useEffect(() => {
    let stop = false;
    let timer = 0;
    let expires = 0;
    const load = async () => {
      try {
        const d = await fetcher();
        if (stop) return;
        if (!d) {
          setInfo(null);
          setState('revoked');
          timer = window.setTimeout(load, 20_000);
          return;
        }
        expires = Date.now() + d.seconds_left * 1000;
        setInfo(d);
        setLeft(d.seconds_left);
        setState('ok');
        timer = window.setTimeout(load, d.seconds_left * 1000 + 400);
      } catch {
        if (stop) return;
        setState('offline');
        timer = window.setTimeout(load, 4000);
      }
    };
    void load();
    const tick = window.setInterval(() => setLeft(Math.max(0, Math.ceil((expires - Date.now()) / 1000))), 500);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      window.clearInterval(tick);
    };
  }, [fetcher]);

  // Un code expiré ne doit jamais rester affiché, même hors connexion.
  return { info: left > 0 ? info : null, left, state };
}

/** QR code et code à 6 chiffres du moment. */
export function CodeView({ info, left }: { info: CodeInfo | null; left: number }) {
  const [svg, setSvg] = useState('');
  const link = info ? punchLink(info) : '';
  useEffect(() => {
    let alive = true;
    if (!link) {
      setSvg('');
      return;
    }
    void QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#113f24', light: '#ffffff' } }).then((s) => alive && setSvg(s));
    return () => {
      alive = false;
    };
  }, [link]);

  if (!info) return <div className="qr" style={{ display: 'grid', placeItems: 'center' }}><Spinner /></div>;
  return (
    <>
      <div className="qr" data-link={link} role="img" aria-label="QR code de pointage" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="digits num" data-testid="code">{info.code}</p>
      <p className="sub">
        Nouveau code dans <b className="num">{left}</b> s
      </p>
    </>
  );
}
