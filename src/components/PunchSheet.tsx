import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useRefresh, useSites } from '../lib/data';
import { PUNCH_ERROR, parsePunchLink, punch } from '../lib/punch';
import { frError } from '../lib/supabase';
import { fmtTime } from '../lib/time';
import { Field, Sheet, Spinner, useToast } from './ui';

interface Detector { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> }

/** Ouvre la caméra arrière et appelle onText pour chaque QR code lu. */
function useQrCamera(active: boolean, onText: (t: string) => void, onFail: () => void) {
  const video = useRef<HTMLVideoElement>(null);
  const cb = useRef({ onText, onFail });
  cb.current = { onText, onFail };

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let detector: Detector | null = null;
    let jsQR: typeof import('jsqr').default | null = null;
    try {
      const D = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      if (D) detector = new D({ formats: ['qr_code'] });
    } catch {
      detector = null;
    }

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('caméra indisponible');
        // Le lecteur de secours n'est chargé que si le navigateur ne sait pas lire les QR codes lui-même.
        if (!detector) jsQR = (await import('jsqr')).default;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        const v = video.current;
        if (stopped || !v) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        v.srcObject = stream;
        await v.play();
        let last = 0;
        const tick = async (t: number) => {
          if (stopped) return;
          if (t - last > 200 && v.readyState >= 2 && v.videoWidth) {
            last = t;
            let text: string | null = null;
            if (detector) {
              try {
                text = (await detector.detect(v))[0]?.rawValue ?? null;
              } catch {
                detector = null;
                jsQR = (await import('jsqr')).default;
              }
            }
            if (!detector && ctx && jsQR) {
              const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
              canvas.width = Math.round(v.videoWidth * k);
              canvas.height = Math.round(v.videoHeight * k);
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
            }
            if (text && !stopped) cb.current.onText(text);
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        if (!stopped) cb.current.onFail();
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active]);

  return video;
}

/** Pointer son arrivée ou son départ : en scannant le QR code de la borne, ou en saisissant son code. */
export function PunchSheet({ action, onClose }: { action: 'in' | 'out'; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const sites = useSites();
  const active = (sites.data ?? []).filter((s) => s.active);
  const [mode, setMode] = useState<'scan' | 'code'>('scan');
  const [camFailed, setCamFailed] = useState(false);
  const [site, setSite] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const busy = useRef(false);
  const [sending, setSending] = useState(false);
  const what = action === 'in' ? 'Arrivée' : 'Départ';

  const send = useCallback(
    async (s: string, c: string) => {
      if (busy.current) return;
      busy.current = true;
      setSending(true);
      setErr('');
      try {
        const r = await punch(s, c, action);
        if (r.ok) {
          await refresh('entries');
          toast(`${what} pointé${action === 'in' ? 'e' : ''} à ${fmtTime(new Date())}`);
          onClose();
          return;
        }
        setErr(PUNCH_ERROR[r.error] ?? r.error);
        if (r.error === 'stale_closed') await refresh('entries');
      } catch (e) {
        setErr(frError(e));
      }
      setSending(false);
      // Laisse le temps de lire le message avant de relire le même QR code.
      window.setTimeout(() => (busy.current = false), 2500);
    },
    [action, onClose, refresh, toast, what],
  );

  const video = useQrCamera(
    mode === 'scan',
    (text) => {
      const p = parsePunchLink(text);
      if (p) void send(p.site, p.code);
      else if (!busy.current) setErr("Ce QR code n'est pas celui de la borne de pointage.");
    },
    () => {
      setCamFailed(true);
      setMode('code');
    },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const s = site || active[0]?.id;
    if (!s) return setErr('Aucun lieu de pointage actif.');
    if (!/^\d{6}$/.test(code)) return setErr('Le code a 6 chiffres.');
    void send(s, code);
  };

  return (
    <Sheet title={`Pointer mon ${action === 'in' ? 'arrivée' : 'départ'}`} onClose={onClose}>
      <div className="seg" role="group" aria-label="Façon de pointer">
        <button type="button" aria-pressed={mode === 'scan'} onClick={() => { setErr(''); setMode('scan'); setCamFailed(false); }}>Scanner</button>
        <button type="button" aria-pressed={mode === 'code'} onClick={() => { setErr(''); setMode('code'); }}>Saisir le code</button>
      </div>

      {mode === 'scan' ? (
        <>
          <video ref={video} className="video" playsInline muted aria-label="Caméra" />
          <p className="note">Vise le QR code affiché sur la borne. Le pointage part dès qu'il est lu.</p>
        </>
      ) : (
        <form className="form" onSubmit={submit}>
          {camFailed && <p className="note">Caméra indisponible ou refusée. Saisis le code à 6 chiffres affiché sous le QR code.</p>}
          {active.length > 1 && (
            <Field label="Lieu">
              <select className="in" value={site || active[0]?.id} onChange={(e) => setSite(e.target.value)}>
                {active.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
              </select>
            </Field>
          )}
          <Field label="Code affiché sur la borne">
            <input className="in code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} placeholder="000000" value={code} autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </Field>
          <button className="btn pri block" disabled={sending || code.length !== 6}>
            {sending ? <Spinner /> : `Pointer mon ${action === 'in' ? 'arrivée' : 'départ'}`}
          </button>
        </form>
      )}
      {err && <p className="err" role="alert">{err}</p>}
    </Sheet>
  );
}
