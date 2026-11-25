import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MercCost, MercIngredient, MercLine, MercOrder, MercPrice, MercRecipe, MercSource } from './production';
import type { MenuCost, MenuItem, MenuLine, MenuLineCost } from './carte';
import type { Tabs } from './dashboard';
import type { DeliverySettings } from './delivery';
import type { DriveFile } from './driveTree';
import { supabase } from './supabase';
import type { MercProcess } from './process';
import type { BookingSettings, AccountantAccess, Checklist, ColdUnit, Contact, Customer, Deadline, EmailLogEntry, EmailSettings, Issue, Kiosk, NubaEvent, Procedure, ProcedureRead, Recipe, LeaveRequest, OilLog, StaffDocument, OpeningHour, Order, Product, Profile, Reservation, Shift, ShiftChange, ShiftSwap, Site, SiteWeekly, Supplier, TempReading, TimeEntry, TodayTasks, TraceItem } from './types';

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
/**
 * Absences et demandes depuis `since`. La base donne à chacun les siennes (et toutes aux responsables) ;
 * celles des collègues arrivent par team_absences, sans motif ni note : on sait seulement qui est absent.
 */
export function useLeaves(since: string) {
  return useQuery({
    queryKey: ['leaves', since],
    queryFn: async () => {
      const own = must<LeaveRequest[]>(await supabase.from('leave_requests').select('*').gte('end_date', since).order('start_date'));
      const { data, error } = await supabase.rpc('team_absences', { p_since: since });
      // Base sans la 0020 : seulement ce que la table donne.
      if (error) return own;
      const known = new Set(own.map((l) => l.id));
      const others = ((data ?? []) as Pick<LeaveRequest, 'id' | 'profile_id' | 'start_date' | 'end_date' | 'part'>[])
        .filter((l) => !known.has(l.id))
        .map((l) => ({ ...l, kind: 'conge' as const, status: 'approved' as const, note: '', created_at: '' }));
      return [...own, ...others].sort((a, b) => a.start_date.localeCompare(b.start_date));
    },
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

/** Mes services ajoutés, modifiés ou retirés que je n'ai pas encore vus (migration 0027). */
export function useShiftChanges() {
  return useQuery({
    queryKey: ['shift-changes'],
    queryFn: async () => {
      const r = await supabase.from('shift_changes').select('id, kind, starts_at, ends_at, area, old_starts_at, old_ends_at, old_area, created_at, emailed_at')
        .is('seen_at', null).order('starts_at').limit(20);
      // Base pas encore mise à jour : rien à montrer.
      if (r.error) return [] as ShiftChange[];
      return r.data as ShiftChange[];
    },
    refetchInterval: 120_000,
  });
}

/** La fermeture de caisse du jour de service (migration 0026) ; null si la base n'est pas à jour. */
export function useClosingToday() {
  return useQuery({
    queryKey: ['caisse', 'aujourdhui'],
    queryFn: async () => {
      const r = await supabase.rpc('cash_closing_get', { p_day: null });
      if (r.error) return null;
      return r.data as { day: string; closing: { status: 'draft' | 'closed'; z_total: number | null } | null; closed_by_name: string | null };
    },
    refetchInterval: 120_000,
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

/** Demandes de réservation à valider, du jour donné (AAAA-MM-JJ) aux suivants. */
export function usePendingBookings(from: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['reservations', 'pending', from],
    enabled: enabled && !!from,
    queryFn: async () => must<Reservation[]>(await supabase.from('reservations').select('*').eq('status', 'pending').gte('day', from!).order('day').order('slot')),
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

/** Rendez-vous de chaque semaine, lus dans le fichier du site (vide avant la mise à jour 0024). */
export function useSiteWeekly(enabled = true) {
  return useQuery({
    queryKey: ['events', 'weekly'],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.from('site_weekly').select('*').order('position');
      // Base pas encore mise à jour : pas de rendez-vous, sans erreur.
      if (error) return [] as SiteWeekly[];
      return (data ?? []) as SiteWeekly[];
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
/** Fiches process des plats Mijote (vide avant la mise à jour 0023). */
export function useProcesses() {
  return useQuery({
    queryKey: ['merc', 'process'],
    queryFn: async () => {
      const { data, error } = await supabase.from('merc_process').select('*');
      if (error) return [] as MercProcess[];
      return (data ?? []) as MercProcess[];
    },
  });
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

/** En-tête des bons de livraison (migration 0018). */
export function useDeliverySettings() {
  return useQuery({
    queryKey: ['delivery'],
    queryFn: async () => must<DeliverySettings | null>(await supabase.from('delivery_settings').select('*').maybeSingle()),
  });
}

/** Tableau de bord financier (migration 0019) : la base ne le donne qu'aux gérants. */
export interface DashboardSource { sheet_url: string; file_name: string; synced_at: string | null; tabs: Tabs }
export function useDashboard(enabled: boolean) {
  return useQuery({
    queryKey: ['dashboard'],
    enabled,
    queryFn: async () => must<DashboardSource | null>(await supabase.from('dashboard_source').select('sheet_url, file_name, synced_at, tabs').maybeSingle()),
  });
}

/* ---------- Documents de l'équipe (migration 0020) ---------- */
/** Mes documents envoyés (la base ne donne que les siens à chacun). */
export function useMyDocuments(profileId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['documents', 'mine', profileId],
    enabled: enabled && !!profileId,
    queryFn: async () => must<StaffDocument[]>(await supabase.from('staff_documents').select('*').eq('profile_id', profileId!).order('created_at', { ascending: false })),
  });
}
export interface TeamDocuments {
  people: { id: string; first_name: string; last_name: string; active: boolean; folder_url: string | null }[];
  documents: StaffDocument[];
}
/** Tous les documents, avec les noms : gérant et comptable. */
export function useTeamDocuments(enabled = true) {
  return useQuery({
    queryKey: ['documents', 'team'],
    enabled,
    queryFn: async () => must<TeamDocuments>(await supabase.rpc('team_documents')),
  });
}
/** Le dossier des salariés copié depuis le Drive (migration 0028) : gérant et comptable. Vide avant la mise à jour. */
export function useDriveFiles(enabled = true) {
  return useQuery({
    queryKey: ['drive', 'files'],
    enabled,
    queryFn: async () => {
      const r = await supabase.from('drive_files').select('id, folder, name, mime, size, modified_at, profile_id, storage_path, pending_path').limit(5000);
      if (r.error) return [] as DriveFile[];
      return r.data as DriveFile[];
    },
  });
}
export interface DriveSource { folder_url: string; synced_at: string | null; counts: Record<string, number>; problems: string[] }
export function useDriveSource(enabled = true) {
  return useQuery({
    queryKey: ['drive', 'source'],
    enabled,
    queryFn: async () => {
      const r = await supabase.from('drive_source').select('folder_url, synced_at, counts, problems').maybeSingle();
      if (r.error) return null;
      return r.data as DriveSource | null;
    },
  });
}

/** Lien vers la caisse Zelty, pour la comptable (gérant et comptable). */
export function useAccountingSettings(enabled = true) {
  return useQuery({
    queryKey: ['accounting'],
    enabled,
    queryFn: async () => must<{ zelty_url: string } | null>(await supabase.from('accounting_settings').select('zelty_url').maybeSingle()),
  });
}
/** Cases cochées de la liste de courses d'un jour, partagées entre tous les appareils. */
export function useShoppingChecks(day: string) {
  return useQuery({
    queryKey: ['shopping', day],
    enabled: !!day,
    refetchInterval: 20000,
    queryFn: async () => must<{ item: string; checked_by: string | null }[]>(await supabase.from('shopping_checks').select('item, checked_by').eq('day', day)),
  });
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
