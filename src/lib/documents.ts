/**
 * Documents de l'équipe : le fichier part dans l'espace de stockage privé « staff-docs »,
 * sous le dossier de la personne, puis add_staff_document l'enregistre (et prévient la comptable).
 * Les photos trop lourdes sont réduites avant l'envoi ; un PDF part tel quel (10 Mo au plus).
 */
import { supabase } from './supabase';
import type { DocCategory } from './types';

export const BUCKET = 'staff-docs';
export const MAX_BYTES = 10 * 1024 * 1024;
const OK_TYPES = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/;

/** Une photo de plus de 1,5 Mo est réduite à 2 000 pixels, en JPEG. Si le navigateur ne sait pas la lire, elle part telle quelle. */
export async function shrink(file: File): Promise<{ data: Blob; type: string; ext: string }> {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || (file.type === 'application/pdf' ? 'pdf' : 'jpg');
  if (!file.type.startsWith('image/') || file.size < 1_500_000 || typeof createImageBitmap === 'undefined') return { data: file, type: file.type, ext };
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
    return blob ? { data: blob, type: 'image/jpeg', ext: 'jpg' } : { data: file, type: file.type, ext };
  } catch {
    return { data: file, type: file.type, ext };
  }
}

/** Ce qui ne va pas avec un fichier, ou une chaîne vide. */
export function fileProblem(file: File | null): string {
  if (!file) return 'Choisis un fichier ou prends une photo.';
  if (file.type && !OK_TYPES.test(file.type)) return 'Envoie un PDF ou une photo (JPEG, PNG, HEIC).';
  if (file.size > MAX_BYTES * 3) return 'Fichier trop lourd : 10 Mo au plus.';
  return '';
}

export interface DocMeta { category: DocCategory; title: string; start: string; end: string; note: string }

/** Envoie le fichier puis l'enregistre. Renvoie un message d'erreur en français, ou une chaîne vide. */
export async function sendDocument(file: File, profileId: string, meta: DocMeta): Promise<string> {
  const { data, type, ext } = await shrink(file);
  if (data.size > MAX_BYTES) return 'Fichier trop lourd : 10 Mo au plus. Pour un PDF, scanne-le en qualité normale.';
  // Un bulletin de paie se nomme « paie-AAAA-MM-… » : c'est ce qui permet à la comptable de le déposer.
  const prefix = meta.category === 'paie' ? `paie-${meta.start.slice(0, 7)}-` : '';
  const path = `${profileId}/${prefix}${crypto.randomUUID()}.${ext}`;
  const up = await supabase.storage.from(BUCKET).upload(path, await data.arrayBuffer(), { contentType: type || 'application/octet-stream', upsert: false });
  if (up.error) {
    const m = up.error.message;
    if (/bucket not found/i.test(m)) return "L'espace des documents n'est pas encore prêt : le gérant doit exécuter la mise à jour 0020 dans Supabase.";
    if (/row-level security|unauthori[sz]ed|403/i.test(m)) return meta.category === 'paie' ? "Envoi refusé : la mise à jour 0021 n'est peut-être pas encore faite dans Supabase." : "Envoi refusé : connecte-toi avec ton compte (pas avec le code PIN de l'iPad).";
    return `Envoi impossible : ${m}`;
  }
  const { error } = await supabase.rpc('add_staff_document', {
    p_profile: profileId, p_category: meta.category, p_title: meta.title.trim(), p_path: path, p_file_name: file.name.slice(0, 200),
    p_mime: type, p_size: data.size, p_start: meta.start || null, p_end: meta.end || meta.start || null, p_note: meta.note.trim(),
  });
  return error ? error.message : '';
}

/** Mois d'un bulletin : « novembre 2026 ». */
export const monthLabel = (day: string) => new Date(`${day.slice(0, 7)}-15T12:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
/** Le mois précédent, au format AAAA-MM. */
export function lastMonth(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Retire un bulletin de paie (comptable : ceux qu'elle a déposés ; gérant : tous), puis son fichier. */
export async function removePayslip(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('delete_payslip', { p_id: id });
  if (error) return error.message;
  await supabase.storage.from(BUCKET).remove([data as string]);
  return '';
}

/** Lien temporaire (2 minutes) pour ouvrir un document. */
export async function documentUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 120);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'Lien indisponible');
  return data.signedUrl;
}
