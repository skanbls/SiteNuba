/**
 * Thème de l'appli sur cet appareil : automatique (celui du téléphone), clair ou sombre.
 * Le choix reste sur l'appareil ; l'appli installée et Safari ont chacun le leur.
 */
export type Theme = 'auto' | 'light' | 'dark';
const KEY = 'nuba-theme';
const BAR: Record<'light' | 'dark', string> = { light: '#F7EDE1', dark: '#08160E' };

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme;
  else root.dataset.theme = t;
  // Couleur de la barre du navigateur : celle du thème choisi, ou celle de l'appareil.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const media = m.getAttribute('media') ?? '';
    m.content = t === 'auto' ? (media.includes('dark') ? BAR.dark : BAR.light) : BAR[t];
  });
}

export function saveTheme(t: Theme) {
  try {
    if (t === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* mémoire indisponible : le choix vaut pour cette ouverture */
  }
  applyTheme(t);
}
