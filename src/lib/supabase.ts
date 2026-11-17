import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const key = import.meta.env.VITE_SUPABASE_KEY as string | undefined;

/** Faux tant que l'adresse et la clé publique du projet Supabase ne sont pas renseignées. */
export const configured = Boolean(url && key);

let ticket = '';
/**
 * Session ouverte par code PIN sur une borne : son ticket accompagne chaque demande à la base,
 * à la place du compte éventuellement connecté sur l'appareil. Chaîne vide pour la fermer.
 */
export const setTicket = (t: string) => {
  ticket = t;
};

const ticketFetch: typeof fetch = (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!ticket || !target.includes('/rest/v1/')) return fetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('x-nuba-ticket', ticket);
  headers.set('Authorization', `Bearer ${key}`);
  return fetch(input, { ...init, headers });
};

export const supabase: SupabaseClient = createClient(url || 'http://localhost', key || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  global: { fetch: ticketFetch },
});

/** Adresse de l'appli sans la partie après le # : sert aux liens des e-mails et des QR codes. */
export const appUrl = () => window.location.origin + window.location.pathname;

/** Messages de Supabase traduits pour l'équipe. */
export function frError(e: unknown): string {
  const err = e as { message?: string; code?: string } | null;
  const m = [err?.code, err?.message || String(e)].filter(Boolean).join(' ');
  if (/PGRST205|PGRST202|42P01|42883|Could not find the (table|function)/i.test(m)) return "Ce module attend une mise à jour de la base : le gérant doit exécuter le dernier script SQL dans Supabase.";
  if (/email_address_not_authorized|not authorized/i.test(m)) return "L'envoi d'e-mails n'est pas encore ouvert à cette adresse. Préviens le gérant.";
  if (/over_email_send_rate_limit|email rate limit/i.test(m)) return "Trop d'e-mails envoyés pour l'instant. Réessaie dans une heure.";
  if (/Invalid login credentials/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(m)) return "Confirme d'abord ton adresse avec le lien reçu par e-mail.";
  if (/already registered|already been registered|user_already_exists/i.test(m)) return 'Un compte existe déjà avec cette adresse. Connecte-toi, ou utilise « Mot de passe oublié ».';
  if (/Password should be at least|weak_password/i.test(m)) return 'Mot de passe trop court : 8 caractères au minimum.';
  if (/rate limit|too many requests/i.test(m)) return 'Trop de tentatives. Réessaie dans quelques minutes.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Connexion impossible. Vérifie ton réseau puis réessaie.';
  if (/duplicate key.*profiles_email_key/i.test(m)) return 'Une personne de l\'équipe a déjà cette adresse e-mail.';
  if (/time_entries_one_open/i.test(m)) return 'Cette personne a déjà une présence en cours.';
  if (/violates foreign key constraint.*time_entries/i.test(m)) return 'Cette personne a des pointages : désactive-la plutôt que de la supprimer.';
  if (/row-level security|permission denied|42501/i.test(m)) return "Tu n'as pas le droit de faire cette action.";
  return err?.message || String(e);
}
