import { useEffect, useRef } from 'react';

interface Detector { detect(src: HTMLVideoElement): Promise<{ rawValue: string }[]> }

/**
 * Ouvre la caméra et appelle onText pour chaque QR code lu.
 * `facing` : 'environment' pour la caméra arrière (scanner la borne avec son téléphone),
 * 'user' pour la caméra avant (présenter un QR code devant un iPad posé sur son support).
 */
export function useQrCamera(active: boolean, onText: (t: string) => void, onFail: () => void, facing: 'environment' | 'user' = 'environment') {
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
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
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
  }, [active, facing]);

  return video;
}
