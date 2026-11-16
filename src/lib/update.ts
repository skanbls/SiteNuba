import { registerSW } from 'virtual:pwa-register';

/** Date de construction de cette version de l'appli. */
export const BUILD: string = __BUILD__;

/** « 16 nov. à 11:00 » : pour savoir quelle version tourne sur un appareil. */
export const buildLabel = () =>
  new Date(BUILD).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', ' à');

let registration: ServiceWorkerRegistration | undefined;
let swUrl = '';

/**
 * Cherche une nouvelle version. S'il y en a une, elle s'installe et l'appli se recharge toute seule.
 * Renvoie vrai si une nouvelle version a été trouvée.
 */
export async function checkForUpdate(): Promise<boolean> {
  if (!registration || !navigator.onLine) return false;
  if (registration.installing || registration.waiting) return true;
  try {
    // L'hébergeur laisse le navigateur garder les fichiers 10 minutes : on relit celui-ci sur le réseau avant de comparer.
    await fetch(swUrl, { cache: 'reload' });
    await registration.update();
  } catch {
    return false; // hors connexion : on réessaiera
  }
  return Boolean(registration.installing || registration.waiting);
}

/**
 * Installe l'appli hors ligne et la garde à jour.
 * Sur iPhone et iPad, une appli de l'écran d'accueil reste ouverte en arrière-plan pendant des jours,
 * et la borne ne se ferme jamais : sans ces vérifications, elles resteraient sur une vieille version.
 */
export function startUpdates() {
  registerSW({
    immediate: true,
    onRegisteredSW(url, reg) {
      swUrl = url;
      registration = reg;
      if (!reg) return;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkForUpdate();
      });
      window.addEventListener('pageshow', () => void checkForUpdate());
      window.setInterval(() => void checkForUpdate(), 5 * 60_000);
    },
  });
}
