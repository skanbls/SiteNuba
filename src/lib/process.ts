/**
 * Fiches process de production (plats Mijote) : étapes, dressage, hygiène et photo du dressage.
 * Une fiche se rattache à un plat par son nom, mis en forme par norm() : la fiche d'une recette
 * (« Poulet Thaï (Mariné) ») sert dans tous les plats sur mesure qui la contiennent ; un plat sur mesure
 * entier (« Purée de PDT + Poulet Thaï (Mariné) + … ») peut avoir sa propre photo et son dressage.
 */
import { supabase } from './supabase';
import { norm, type Brand } from './production';

export const PHOTO_BUCKET = 'dish-photos';

export interface MercProcess {
  brand: Brand;
  dish_key: string;
  name: string;
  steps: string;
  dressing: string;
  haccp: string;
  photo_path: string;
  updated_at: string;
}

/** La clé d'un plat : son nom sans accents ni majuscules. */
export const processKey = (name: string) => norm(name);

export interface Phase { title: string; steps: string[] }

/**
 * Les étapes écrites une par ligne ; une ligne qui commence par « # » ouvre une phase (« # Cuisson »).
 * Les puces ou numéros tapés à la main en début de ligne sont retirés : l'appli numérote elle-même.
 */
export function parseSteps(text: string): Phase[] {
  const phases: Phase[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      phases.push({ title: line.replace(/^#+\s*/, ''), steps: [] });
      continue;
    }
    if (phases.length === 0) phases.push({ title: '', steps: [] });
    phases[phases.length - 1].steps.push(line.replace(/^(\d+[.)]|[-•*])\s+/, ''));
  }
  return phases.filter((p) => p.title || p.steps.length);
}

/** Les lignes d'un texte libre (dressage, hygiène), sans les vides ni les puces tapées à la main. */
export const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim().replace(/^[-•*]\s+/, '')).filter(Boolean);

export const photoUrl = (path: string) => (path ? supabase.storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl : '');

/** Une photo de 1 600 pixels au plus, en JPEG : assez nette sur l'iPad, légère à charger. */
export async function resizePhoto(data: Blob, max = 1600): Promise<Blob> {
  if (typeof createImageBitmap === 'undefined') return data;
  try {
    const bmp = await createImageBitmap(data);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && data.type === 'image/jpeg' && data.size < 900_000) return data;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.84));
    return out ?? data;
  } catch {
    return data;
  }
}

/** Envoie une photo dans l'espace des photos de plats. Renvoie son chemin, ou lève une erreur en français. */
export async function uploadPhoto(brand: Brand, data: Blob): Promise<string> {
  const small = await resizePhoto(data);
  const type = small.type === 'image/png' || small.type === 'image/webp' ? small.type : 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${brand}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, await small.arrayBuffer(), { contentType: type, upsert: false });
  if (error) {
    if (/bucket not found/i.test(error.message)) throw new Error("L'espace des photos n'est pas encore prêt : le gérant doit exécuter la mise à jour 0023 dans Supabase.");
    if (/row-level security|unauthori[sz]ed|403/i.test(error.message)) throw new Error('Envoi refusé : il faut l\'accès « Fiches techniques », avec ton compte (pas le code PIN).');
    throw new Error(`Envoi de la photo impossible : ${error.message}`);
  }
  return path;
}

export interface ProcessInput { brand: Brand; name: string; steps: string; dressing: string; haccp: string; photo: string }

/** Enregistre une fiche ; retire l'ancienne photo si elle a changé. Renvoie un message d'erreur, ou ''. */
export async function saveProcess(p: ProcessInput): Promise<string> {
  const { data, error } = await supabase.rpc('save_process', {
    p_brand: p.brand, p_key: processKey(p.name), p_name: p.name.trim(), p_steps: p.steps, p_dressing: p.dressing, p_haccp: p.haccp, p_photo: p.photo,
  });
  if (error) return /save_process/.test(error.message) && /find|exist|schema cache/i.test(error.message)
    ? 'La mise à jour 0023 n\'est pas encore faite dans Supabase.'
    : error.message;
  if (data) await supabase.storage.from(PHOTO_BUCKET).remove([data as string]);
  return '';
}

export async function deleteProcess(brand: Brand, name: string): Promise<string> {
  const { data, error } = await supabase.rpc('delete_process', { p_brand: brand, p_key: processKey(name) });
  if (error) return error.message;
  if (data) await supabase.storage.from(PHOTO_BUCKET).remove([data as string]);
  return '';
}

/* ---------- Fichier d'import : plusieurs fiches d'un coup, photos comprises ---------- */

export interface ImportItem { brand: Brand; name: string; steps: string; dressing: string; haccp: string; photo: string /* data:image/…;base64,… ou '' */ }

/** Lit un fichier d'import (format « nuba-process »). Renvoie les fiches, ou lève une erreur en français. */
export function parseImport(text: string): ImportItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Ce fichier n'est pas un fichier de fiches process.");
  }
  const o = raw as { format?: unknown; items?: unknown };
  if (!o || o.format !== 'nuba-process-1' || !Array.isArray(o.items)) throw new Error("Ce fichier n'est pas un fichier de fiches process.");
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const items: ImportItem[] = [];
  for (const it of o.items as Record<string, unknown>[]) {
    const brand = it?.brand;
    const name = str(it?.name, 300).trim();
    if ((brand !== 'saveurs_nomades' && brand !== 'comptoir') || !name) continue;
    const photo = str(it.photo, 6_000_000);
    items.push({
      brand, name, steps: str(it.steps, 8000), dressing: str(it.dressing, 3000), haccp: str(it.haccp, 3000),
      photo: /^data:image\/(jpeg|png|webp);base64,/.test(photo) ? photo : '',
    });
  }
  if (items.length === 0) throw new Error('Aucune fiche dans ce fichier.');
  return items;
}

/** Une photo « data:image/jpeg;base64,… » en fichier. */
export function dataUrlBlob(url: string): Blob {
  const [head, b64] = url.split(',', 2);
  const type = /^data:(image\/[a-z]+)/.exec(head)?.[1] ?? 'image/jpeg';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
