import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';
import type { Kiosk, LeaveRequest, Profile, Shift, ShiftSwap, Site, TimeEntry } from './types';

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

/** Services planifiés qui commencent dans [from, to[, dans l'ordre. */
export function useShifts(from: Date, to: Date, profileId?: string) {
  return useQuery({
    queryKey: ['shifts', from.toISOString(), to.toISOString(), profileId ?? 'all'],
    queryFn: async () => {
      let q = supabase.from('shifts').select('*').gte('starts_at', from.toISOString()).lt('starts_at', to.toISOString());
      if (profileId) q = q.eq('profile_id', profileId);
      return must<Shift[]>(await q.order('starts_at'));
    },
  });
}

/** Congés et indisponibilités visibles par la personne, qui finissent après `since` (AAAA-MM-JJ). */
export function useLeaves(since: string) {
  return useQuery({
    queryKey: ['leaves', since],
    queryFn: async () => must<LeaveRequest[]>(await supabase.from('leave_requests').select('*').gte('end_date', since).order('start_date')),
  });
}

/** Demandes d'échange visibles par la personne, les plus récentes d'abord. */
export function useSwaps() {
  return useQuery({
    queryKey: ['swaps'],
    queryFn: async () =>
      must<ShiftSwap[]>(await supabase.from('shift_swaps').select('*, shifts(starts_at, ends_at, area)').order('created_at', { ascending: false }).limit(50)),
  });
}

/** À appeler après toute écriture pour rafraîchir les écrans concernés. */
export function useRefresh() {
  const qc = useQueryClient();
  return (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}
