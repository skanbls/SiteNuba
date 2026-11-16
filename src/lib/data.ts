import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import type { Kiosk, Profile, Site, TimeEntry } from './types';

const ENTRY = '*, time_breaks(*), profiles(first_name, last_name), sites(name)';

function must<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw r.error;
  return r.data as T;
}

export function useSites() {
  return useQuery({
    queryKey: ['sites'],
    queryFn: async () => must<Site[]>(await supabase.from('sites').select('*').order('created_at')),
  });
}

export function useTeam() {
  return useQuery({
    queryKey: ['team'],
    queryFn: async () => must<Profile[]>(await supabase.from('profiles').select('*').order('first_name')),
  });
}

export function useKiosks() {
  return useQuery({
    queryKey: ['kiosks'],
    queryFn: async () => must<Kiosk[]>(await supabase.from('kiosks').select('*, sites(name)').order('created_at')),
  });
}

/** Présence en cours de la personne, ou null. */
export function useMyOpenEntry(profileId: string) {
  return useQuery({
    queryKey: ['entries', 'open', profileId],
    queryFn: async () =>
      must<TimeEntry | null>(
        await supabase.from('time_entries').select(ENTRY).eq('profile_id', profileId).is('clock_out', null).maybeSingle(),
      ),
    refetchInterval: 60_000,
  });
}

/** Toutes les présences en cours (gérant et responsables). */
export function useOpenEntries(enabled: boolean) {
  return useQuery({
    queryKey: ['entries', 'open', 'all'],
    enabled,
    queryFn: async () => must<TimeEntry[]>(await supabase.from('time_entries').select(ENTRY).is('clock_out', null).order('clock_in')),
    refetchInterval: 60_000,
  });
}

/** Pointages commencés dans [from, to[, du plus récent au plus ancien. */
export function useEntries(from: Date, to: Date, profileId?: string) {
  return useQuery({
    queryKey: ['entries', 'range', from.toISOString(), to.toISOString(), profileId ?? 'all'],
    queryFn: async () => {
      let q = supabase.from('time_entries').select(ENTRY).gte('clock_in', from.toISOString()).lt('clock_in', to.toISOString());
      if (profileId) q = q.eq('profile_id', profileId);
      return must<TimeEntry[]>(await q.order('clock_in', { ascending: false }));
    },
  });
}

/** À appeler après toute écriture pour rafraîchir les écrans concernés. */
export function useRefresh() {
  const qc = useQueryClient();
  return (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}
