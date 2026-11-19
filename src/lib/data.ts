import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MercCost, MercIngredient, MercLine, MercOrder, MercPrice, MercRecipe, MercSource } from './production';
import type { MenuCost, MenuItem, MenuLine, MenuLineCost } from './carte';
import { supabase } from './supabase';
import type { BookingSettings, AccountantAccess, Checklist, ColdUnit, Contact, Customer, Deadline, EmailLogEntry, EmailSettings, Issue, Kiosk, NubaEvent, Procedure, ProcedureRead, Recipe, LeaveRequest, OilLog, OpeningHour, Order, Product, Profile, Reservation, Shift, ShiftSwap, Site, Supplier, TempReading, TimeEntry, TodayTasks, TraceItem } from './types';

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

/** Les checklists actives, avec leurs cases cochées ou non pour la période en cours. */
export function useChecklists() {
  return useQuery({
    queryKey: ['checklists'],
    queryFn: async () => must<Checklist[]>(await supabase.rpc('checklists_today')),
    refetchInterval: 60_000,
  });
}

/** Ce qu'il reste à faire aujourd'hui : checklists, relevés, dates limites. */
export function useTodayTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => must<TodayTasks>(await supabase.rpc('today_tasks')),
    refetchInterval: 60_000,
  });
}

export function useColdUnits() {
  return useQuery({
    queryKey: ['units'],
    queryFn: async () => must<ColdUnit[]>(await supabase.from('cold_units').select('*').order('position').order('name')),
  });
}

/** Relevés de température d'un jour de service (AAAA-MM-JJ). */
export function useReadings(day: string | undefined) {
  return useQuery({
    queryKey: ['readings', day],
    enabled: !!day,
    queryFn: async () => must<TempReading[]>(await supabase.from('temp_readings').select('*').eq('day', day!).order('taken_at')),
  });
}

/** Préparations et produits entamés encore en cours, la date limite la plus proche d'abord. */
export function useTrace() {
  return useQuery({
    queryKey: ['trace'],
    queryFn: async () => must<TraceItem[]>(await supabase.from('trace_items').select('*').is('closed_at', null).order('use_by')),
  });
}

export function useOil() {
  return useQuery({
    queryKey: ['oil'],
    queryFn: async () => must<OilLog[]>(await supabase.from('oil_logs').select('*').order('done_at', { ascending: false }).limit(30)),
  });
}

export function useSuppliers() {
  return useQuery({
    queryKey: ['suppliers'],
    queryFn: async () => must<Supplier[]>(await supabase.from('suppliers').select('*').order('name')),
  });
}

export function useProducts() {
  return useQuery({
    queryKey: ['products'],
    queryFn: async () => must<Product[]>(await supabase.from('products').select('*').order('category').order('name')),
  });
}

/** Commandes, les plus récentes d'abord, avec leurs lignes. */
export function useOrders() {
  return useQuery({
    queryKey: ['orders'],
    queryFn: async () =>
      must<Order[]>(await supabase.from('orders').select('*, suppliers(name, phone, email), order_lines(*, products(name, unit))').order('created_at', { ascending: false }).limit(60)),
  });
}

/** Réservations d'un jour (AAAA-MM-JJ), dans l'ordre d'arrivée. */
export function useReservations(day: string) {
  return useQuery({
    queryKey: ['reservations', day],
    queryFn: async () => must<Reservation[]>(await supabase.from('reservations').select('*').eq('day', day).order('slot').order('created_at')),
    refetchInterval: 60_000,
  });
}

export function useBookingSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['booking', 'settings'],
    enabled,
    queryFn: async () => must<BookingSettings>(await supabase.from('booking_settings').select('*').single()),
  });
}

export function useOpeningHours(enabled: boolean) {
  return useQuery({
    queryKey: ['booking', 'hours'],
    enabled,
    queryFn: async () => must<OpeningHour[]>(await supabase.from('opening_hours').select('*').order('weekday')),
  });
}

export function useCustomers() {
  return useQuery({
    queryKey: ['customers'],
    queryFn: async () => must<Customer[]>(await supabase.from('customers').select('*').order('name')),
  });
}

/** Événements à partir d'un jour (AAAA-MM-JJ), ou passés si `past`, avec leur préparation. */
export function useEvents(from: string, past: boolean) {
  return useQuery({
    queryKey: ['events', from, past],
    queryFn: async () => {
      const q = supabase.from('events').select('*, event_tasks(*)');
      return must<NubaEvent[]>(await (past ? q.lt('day', from).order('day', { ascending: false }).limit(40) : q.or(`day.gte.${from},end_day.gte.${from}`).order('day').limit(200)));
    },
  });
}

export function useRecipes() {
  return useQuery({
    queryKey: ['recipes'],
    queryFn: async () => must<Recipe[]>(await supabase.from('recipes').select('*, recipe_items(*)').order('category').order('name')),
  });
}

export function useIssues() {
  return useQuery({
    queryKey: ['issues'],
    queryFn: async () => must<Issue[]>(await supabase.from('issues').select('*').order('reported_at', { ascending: false }).limit(80)),
  });
}

/** Échéances : réservées au gérant. */
export function useDeadlines(enabled: boolean) {
  return useQuery({
    queryKey: ['deadlines'],
    enabled,
    queryFn: async () => must<Deadline[]>(await supabase.from('deadlines').select('*').eq('active', true).order('due_date')),
  });
}

export function useProcedures() {
  return useQuery({
    queryKey: ['procedures'],
    queryFn: async () => must<Procedure[]>(await supabase.from('procedures').select('*').order('position')),
  });
}

/** Lectures confirmées : les miennes, ou celles de toute l'équipe pour le gérant. */
export function useProcedureReads() {
  return useQuery({
    queryKey: ['procedures', 'reads'],
    queryFn: async () => must<ProcedureRead[]>(await supabase.from('procedure_reads').select('*')),
  });
}

/** À appeler après toute écriture pour rafraîchir les écrans concernés. */
/** Accès confiés aux responsables (le gérant les voit tous). */
export function useAllRights(enabled: boolean) {
  return useQuery({
    queryKey: ['rights', 'all'],
    enabled,
    queryFn: async () => must<{ profile_id: string; area: string }[]>(await supabase.from('profile_rights').select('profile_id, area')),
  });
}

/** Liens vers le dossier Drive de chaque personne (gérant). */
export function useFolders(enabled: boolean) {
  return useQuery({
    queryKey: ['folders'],
    enabled,
    queryFn: async () => must<{ profile_id: string; url: string }[]>(await supabase.from('profile_folders').select('profile_id, url')),
  });
}

/** Réglages des e-mails (gérant). */
export function useEmailSettings() {
  return useQuery({
    queryKey: ['emails', 'settings'],
    queryFn: async () => must<EmailSettings>(await supabase.from('email_settings').select('*').single()),
  });
}

/** Derniers e-mails et leur sort (gérant). */
export function useEmailLog() {
  return useQuery({
    queryKey: ['emails', 'log'],
    queryFn: async () => must<EmailLogEntry[]>(await supabase.rpc('email_log')),
  });
}

/**
 * Toutes les lignes d'une table, par pages de 1 000 : Supabase n'en rend pas plus d'un coup.
 * `order` doit désigner une colonne unique, pour que les pages ne se chevauchent pas.
 */
async function selectAll<T>(table: string, columns: string, order: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select(columns);
    for (const o of order) q = q.order(o);
    const page = must<T[]>((await q.range(from, from + 999)) as unknown as { data: T[] | null; error: { message: string } | null });
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/* ---------- Production : mercuriales synchronisées depuis Google Sheets ---------- */
export function useMercSources() {
  return useQuery({ queryKey: ['merc', 'sources'], queryFn: () => selectAll<MercSource>('merc_sources', '*', ['brand']) });
}
export function useMercRecipes() {
  return useQuery({ queryKey: ['merc', 'recipes'], queryFn: () => selectAll<MercRecipe>('merc_recipes', '*', ['brand', 'name']) });
}
export function useMercLines() {
  return useQuery({ queryKey: ['merc', 'lines'], queryFn: () => selectAll<MercLine>('merc_lines', '*', ['id']) });
}
export function useMercOrders() {
  return useQuery({ queryKey: ['merc', 'orders'], queryFn: () => selectAll<MercOrder>('merc_orders', '*', ['id']) });
}
export function useMercIngredients() {
  return useQuery({ queryKey: ['merc', 'ingredients'], queryFn: () => selectAll<MercIngredient>('merc_ingredients', '*', ['name']) });
}
/** Prix et coûts : seulement pour qui a l'accès aux fiches techniques. */
export function useMercPrices(enabled: boolean) {
  return useQuery({ queryKey: ['merc', 'prices'], enabled, queryFn: () => selectAll<MercPrice>('merc_ingredient_prices', '*', ['name']) });
}
export function useMercCosts(enabled: boolean) {
  return useQuery({ queryKey: ['merc', 'costs'], enabled, queryFn: () => selectAll<MercCost>('merc_recipe_costs', '*', ['brand', 'name']) });
}

/* ---------- La carte Nuba (mercuriale Nuba) ---------- */
/** `enabled` : seulement quand la base connaît la carte (migration 0017). */
export function useMenuItems(enabled: boolean) {
  return useQuery({ queryKey: ['carte', 'items'], enabled, queryFn: () => selectAll<MenuItem>('menu_items', '*', ['kind', 'name']) });
}
export function useMenuLines(enabled: boolean) {
  return useQuery({ queryKey: ['carte', 'lines'], enabled, queryFn: () => selectAll<MenuLine>('menu_lines', '*', ['kind', 'recipe', 'position']) });
}
/** Coûts et prix d'achat : accès fiches techniques seulement. */
export function useMenuCosts(enabled: boolean) {
  return useQuery({ queryKey: ['carte', 'costs'], enabled, queryFn: () => selectAll<MenuCost>('menu_costs', '*', ['kind', 'name']) });
}
export function useMenuLineCosts(enabled: boolean) {
  return useQuery({ queryKey: ['carte', 'line-costs'], enabled, queryFn: () => selectAll<MenuLineCost>('menu_line_costs', '*', ['kind', 'recipe', 'position']) });
}

/** Numéros utiles, urgences d'abord. */
export function useContacts() {
  return useQuery({
    queryKey: ['contacts'],
    queryFn: async () => must<Contact[]>(await supabase.from('contacts').select('*').order('urgent', { ascending: false }).order('position').order('name')),
  });
}

/** Accès de la comptable (gérant). */
export function useAccountants(enabled: boolean) {
  return useQuery({
    queryKey: ['accountants'],
    enabled,
    queryFn: async () => must<AccountantAccess[]>(await supabase.from('accountants').select('*').order('created_at')),
  });
}

export function useRefresh() {
  const qc = useQueryClient();
  return (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}
