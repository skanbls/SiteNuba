/**
 * Affiches des événements : un lien vers une image en ligne, écrit dans la colonne « Affiche »
 * du fichier « Contenu du site ». Un lien de partage Google Drive (« Copier le lien ») ne montre
 * pas l'image elle-même : on le change en lien d'aperçu. Le fichier doit être partagé
 * « Tous les utilisateurs disposant du lien ».
 */
export function driveId(url: string): string {
  const t = url.trim();
  if (!/^https:\/\/(drive|docs)\.google\.com\//.test(t)) return '';
  const m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(t) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(t);
  return m?.[1] ?? '';
}

/** L'adresse à mettre dans une image, ou '' si le lien n'est pas une adresse https. */
export function posterSrc(url: string, width = 1200): string {
  const t = (url ?? '').trim();
  if (!/^https:\/\/\S+$/.test(t)) return '';
  const id = driveId(t);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w${width}` : t;
}
