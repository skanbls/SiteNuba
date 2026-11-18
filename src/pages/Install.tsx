import QRCode from 'qrcode';
import { useEffect, useState, type ReactNode } from 'react';
import { BrandHead } from '../components/Logo';
import { Icon } from '../components/Icon';
import { useToast } from '../components/ui';
import { appUrl } from '../lib/supabase';

type Device = 'ios' | 'android' | 'computer';

/** iPhone, iPad (même quand il se présente comme un Mac), Android ou ordinateur. */
function detect(): Device {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'computer';
}

const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

/** Ouvert depuis Instagram, Facebook, WhatsApp… : ces navigateurs intégrés ne savent pas installer. */
const inAppBrowser = () => /Instagram|FBAN|FBAV|WhatsApp|Line\//.test(navigator.userAgent);

const STEPS: Record<Device, { title: string; steps: ReactNode[] }> = {
  ios: {
    title: 'iPhone et iPad',
    steps: [
      <>Ouvre ce lien dans <b>Safari</b> (pas dans Chrome, Instagram ou WhatsApp).</>,
      <>Touche le bouton <b>Partager</b> : un carré avec une flèche vers le haut, en bas de l'écran sur iPhone, en haut sur iPad.</>,
      <>Fais défiler et touche <b>« Sur l'écran d'accueil »</b>, puis <b>« Ajouter »</b>.</>,
      <>L'icône Nuba apparaît sur l'écran d'accueil : ouvre toujours l'appli depuis cette icône.</>,
    ],
  },
  android: {
    title: 'Android',
    steps: [
      <>Ouvre ce lien dans <b>Chrome</b>.</>,
      <>Touche le menu <b>⋮</b> en haut à droite.</>,
      <>Touche <b>« Installer l'application »</b> (ou « Ajouter à l'écran d'accueil »), puis <b>« Installer »</b>.</>,
    ],
  },
  computer: {
    title: 'Ordinateur',
    steps: [
      <>Dans <b>Chrome</b> ou <b>Edge</b> : clique sur l'icône d'installation à droite de la barre d'adresse (un écran avec une flèche), puis <b>« Installer »</b>.</>,
      <>Sur Mac avec <b>Safari</b> : menu <b>Fichier</b>, puis <b>« Ajouter au Dock »</b>.</>,
    ],
  },
};

/**
 * Installer l'appli : page publique, à ouvrir ou à montrer à l'équipe avant même d'avoir un compte.
 * Le QR code mène à l'appli ; les étapes s'adaptent à l'appareil.
 */
export default function Install() {
  const toast = useToast();
  const device = detect();
  const url = appUrl();
  const [qr, setQr] = useState('');
  const [prompt, setPrompt] = useState<(Event & { prompt?: () => Promise<void> }) | null>(
    () => (window as unknown as { nubaInstall?: Event }).nubaInstall ?? null,
  );

  useEffect(() => {
    void QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#113f24', light: '#ffffff' } }).then(setQr);
    const keep = (e: Event) => {
      e.preventDefault();
      setPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', keep);
    return () => window.removeEventListener('beforeinstallprompt', keep);
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast("Lien de l'appli copié");
    } catch {
      toast(url);
    }
  }

  const order: Device[] = [device, ...(['ios', 'android', 'computer'] as Device[]).filter((d) => d !== device)];
  return (
    <div className="full">
      <div className="card wide">
        <BrandHead />
        <div>
          <h1>Installer l'appli</h1>
          <p className="sub">Elle s'installe depuis ce lien, sans passer par l'App Store ni le Play Store, et se met à jour toute seule.</p>
        </div>

        {installed() ? (
          <p className="pill ok" style={{ alignSelf: 'flex-start' }}>L'appli est déjà installée sur cet appareil</p>
        ) : prompt?.prompt ? (
          <button type="button" className="btn pri block" onClick={() => void prompt.prompt?.().then(() => setPrompt(null))}><Icon name="down" />Installer l'appli sur cet appareil</button>
        ) : null}
        {inAppBrowser() && <p className="err">Tu es dans le navigateur d'une autre appli : ouvre ce lien dans Safari (iPhone) ou Chrome (Android) pour pouvoir l'installer.</p>}

        {order.map((d, i) => (
          <details key={d} className="guide" open={i === 0} data-device={d}>
            <summary>{STEPS[d].title}{i === 0 ? ' (cet appareil)' : ''}</summary>
            <ol>{STEPS[d].steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
          </details>
        ))}

        <div className="panel">
          <p className="t">Pour un autre téléphone</p>
          <div className="qr install-qr" role="img" aria-label="QR code vers l'appli" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className="sub">Scanne ce code avec l'appareil photo, puis suis les étapes ci-dessus.</p>
          <p className="sub" style={{ wordBreak: 'break-all' }}>{url}</p>
          <button type="button" className="btn" onClick={() => void copy()}><Icon name="copy" />Copier le lien</button>
        </div>

        <a className="btn pri block" href="#/guide">Ensuite : lire le guide de l'appli</a>
        <a className="btn block" href="#/">Ouvrir l'appli</a>
      </div>
    </div>
  );
}
