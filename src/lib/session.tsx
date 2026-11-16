import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { frError, setTicket, supabase } from './supabase';
import type { Profile } from './types';

/** Sans activité pendant ce délai, une session ouverte par code PIN se ferme toute seule. */
const PIN_IDLE_MS = Number(import.meta.env.VITE_PIN_IDLE_MS) || 120_000;

interface Ctx {
  /** Compte connecté par e-mail et mot de passe, s'il y en a un. */
  session: Session | null;
  /** Vrai dans une session ouverte par code PIN sur l'iPad partagé. Elle a les droits d'un équipier. */
  pin: boolean;
  /** Fiche d'équipe de la personne, ou null si le compte n'est rattaché à personne. */
  profile: Profile | null;
  loading: boolean;
  /** Le chargement du profil a échoué (réseau, base). */
  problem: string;
  /** Arrivée par un lien « mot de passe oublié » : il faut choisir un nouveau mot de passe. */
  recovery: boolean;
  endRecovery(): void;
  reload(): Promise<void>;
  /** Ouvre une session par code PIN avec le ticket rendu par la borne. */
  startPin(ticket: string): void;
  /** Déconnexion du compte, ou « Terminer » dans une session par code PIN (retour à la borne). */
  signOut(): Promise<void>;
}

const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children, initialRecovery }: { children: ReactNode; initialRecovery: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [pinTicket, setPinTicket] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [problem, setProblem] = useState('');
  const [recovery, setRecovery] = useState(initialRecovery);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  // Qui utilise l'appli : la session à code PIN passe avant le compte connecté sur l'appareil.
  const identity = pinTicket ? `pin:${pinTicket}` : session?.user.id ?? null;

  const startPin = useCallback((ticket: string) => {
    setTicket(ticket);
    setPinTicket(ticket);
  }, []);

  const endPin = useCallback(async () => {
    try {
      await supabase.rpc('kiosk_logout');
    } catch {
      /* la session expirera toute seule */
    }
    setTicket('');
    setPinTicket('');
    window.location.hash = '#/borne';
  }, []);

  const reload = useCallback(async () => {
    if (!identity) {
      setProfile(null);
      setProblem('');
      setLoadedFor(null);
      return;
    }
    const { data, error } = await supabase.rpc('me');
    const p = error ? null : ((data as Profile[] | null) ?? [])[0] ?? null;
    if (identity.startsWith('pin:') && !p) {
      // Ticket expiré ou refusé : retour à la borne.
      await endPin();
      return;
    }
    setProblem(error ? frError(error) : '');
    setProfile(p);
    setLoadedFor(identity);
  }, [identity, endPin]);

  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);

  // Session par code PIN : verrouillage après un temps sans activité, et prolongation tant qu'on s'en sert.
  useEffect(() => {
    if (!pinTicket) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }));
    const idle = window.setInterval(() => {
      if (Date.now() - last > PIN_IDLE_MS) void endPin();
    }, 1000);
    const keep = window.setInterval(() => void supabase.rpc('kiosk_keepalive'), 5 * 60_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch, { capture: true }));
      window.clearInterval(idle);
      window.clearInterval(keep);
    };
  }, [pinTicket, endPin]);

  const value = useMemo<Ctx>(
    () => ({
      session,
      pin: !!pinTicket,
      profile,
      loading: !ready || loadedFor !== identity,
      problem,
      recovery,
      endRecovery: () => setRecovery(false),
      reload,
      startPin,
      signOut: async () => {
        if (pinTicket) await endPin();
        else await supabase.auth.signOut();
      },
    }),
    [session, pinTicket, profile, ready, loadedFor, identity, problem, recovery, reload, startPin, endPin],
  );
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('SessionProvider manquant');
  return c;
}

/** Profil de la personne, dans les écrans qui ne s'affichent qu'une fois identifié. */
export function useMe(): Profile {
  const { profile } = useSession();
  if (!profile) throw new Error('Profil manquant');
  return profile;
}
