import { appUrl, supabase } from './supabase';
import type { CodeInfo, PunchError, PunchResult } from './types';

/** Lien encodé dans le QR code : ouvre l'appli sur l'écran de pointage, lieu et code compris. */
export const punchLink = (i: Pick<CodeInfo, 'site_id' | 'code'>) => `${appUrl()}#/pointer?s=${i.site_id}&c=${i.code}`;

/** Retrouve le lieu et le code dans le texte d'un QR code scanné. */
export function parsePunchLink(text: string): { site: string; code: string } | null {
  const i = text.lastIndexOf('?');
  if (i < 0) return null;
  const p = new URLSearchParams(text.slice(i + 1));
  const site = p.get('s') || '';
  const code = p.get('c') || '';
  return /^[0-9a-f-]{36}$/i.test(site) && /^\d{6}$/.test(code) ? { site, code } : null;
}

export const PUNCH_ERROR: Record<PunchError, string> = {
  code: 'Code refusé. Il change toutes les 30 secondes : scanne ou saisis celui qui est affiché maintenant.',
  too_many: 'Trop de codes refusés. Attends 10 minutes ou préviens le gérant.',
  already_in: 'Ton arrivée est déjà pointée.',
  not_in: "Aucune arrivée en cours : pointe d'abord ton arrivée.",
  stale_closed: "Ton dernier départ n'avait pas été pointé. Le gérant le corrigera ; tu peux maintenant pointer ton arrivée.",
  site: "Ce lieu de pointage n'existe plus.",
  no_profile: "Ton compte n'est pas rattaché à l'équipe.",
  action: 'Action inconnue.',
  already_paused: 'Tu es déjà en pause.',
  not_paused: "Tu n'es pas en pause.",
};

export async function punch(site: string, code: string, action: 'in' | 'out'): Promise<PunchResult> {
  const { data, error } = await supabase.rpc('punch', { p_site: site, p_code: code, p_action: action });
  if (error) throw error;
  return data as PunchResult;
}

export async function punchBreak(action: 'start' | 'end'): Promise<PunchResult> {
  const { data, error } = await supabase.rpc('punch_break', { p_action: action });
  if (error) throw error;
  return data as PunchResult;
}

/** Pointer sur la borne, dans une session ouverte par code PIN : la présence sur place est déjà prouvée. */
export async function punchKiosk(action: 'in' | 'out'): Promise<PunchResult> {
  const { data, error } = await supabase.rpc('punch_kiosk', { p_action: action });
  if (error) throw error;
  return data as PunchResult;
}
