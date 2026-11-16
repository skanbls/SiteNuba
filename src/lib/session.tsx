import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { frError, supabase } from './supabase';
import type { Profile } from './types';

interface Ctx {
  session: Session | null;
  /** Fiche d'équipe rattachée au compte, ou null si le compte n'est rattaché à personne. */
  profile: Profile | null;
  loading: boolean;
  /** Le chargement du profil a échoué (réseau, base). */
  problem: string;
  /** Arrivée par un lien « mot de passe oublié » : il faut choisir un nouveau mot de passe. */
  recovery: boolean;
  endRecovery(): void;
  reload(): Promise<void>;
  signOut(): Promise<void>;
}

const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children, initialRecovery }: { children: ReactNode; initialRecovery: boolean }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
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

  const uid = session?.user.id ?? null;

  const reload = useCallback(async () => {
    if (!uid) {
      setProfile(null);
      setProblem('');
      setLoadedFor(null);
      return;
    }
    const { data, error } = await supabase.rpc('me');
    if (error) {
      setProblem(frError(error));
      setProfile(null);
    } else {
      setProblem('');
      setProfile(((data as Profile[] | null) ?? [])[0] ?? null);
    }
    setLoadedFor(uid);
  }, [uid]);

  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);

  const value = useMemo<Ctx>(
    () => ({
      session,
      profile,
      loading: !ready || loadedFor !== uid,
      problem,
      recovery,
      endRecovery: () => setRecovery(false),
      reload,
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [session, profile, ready, loadedFor, uid, problem, recovery, reload],
  );
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('SessionProvider manquant');
  return c;
}

/** Profil de la personne connectée, dans les écrans qui ne s'affichent qu'une fois rattaché. */
export function useMe(): Profile {
  const { profile } = useSession();
  if (!profile) throw new Error('Profil manquant');
  return profile;
}
