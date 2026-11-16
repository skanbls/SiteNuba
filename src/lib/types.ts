export type Role = 'gerant' | 'responsable' | 'equipier';
export type Contract = 'cdi' | 'cdd' | 'extra' | 'autre';

export interface Profile {
  id: string;
  user_id: string | null;
  /** Vide pour une personne qui n'utilise que l'iPad, avec son code PIN. */
  email: string | null;
  first_name: string;
  last_name: string;
  role: Role;
  job: string;
  contract: Contract;
  weekly_hours: number;
  active: boolean;
  /** A choisi (ou reçu) un code PIN pour l'iPad partagé. */
  has_pin: boolean;
  created_at: string;
}

export interface Site {
  id: string;
  name: string;
  kind: 'etablissement' | 'evenement';
  active: boolean;
}

export interface TimeBreak {
  id: string;
  entry_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface TimeEntry {
  id: string;
  profile_id: string;
  site_id: string | null;
  clock_in: string;
  clock_out: string | null;
  source: 'qr' | 'manuel' | 'borne';
  note: string;
  needs_review: boolean;
  time_breaks: TimeBreak[];
  profiles?: Pick<Profile, 'first_name' | 'last_name'> | null;
  sites?: Pick<Site, 'name'> | null;
}

export interface Shift {
  id: string;
  profile_id: string;
  site_id: string | null;
  starts_at: string;
  ends_at: string;
  area: string;
  note: string;
}

export type RequestStatus = 'pending' | 'approved' | 'refused';

export interface LeaveRequest {
  id: string;
  profile_id: string;
  kind: 'conge' | 'indisponibilite';
  start_date: string;
  end_date: string;
  note: string;
  status: RequestStatus;
  created_at: string;
}

export interface ShiftSwap {
  id: string;
  shift_id: string;
  from_profile: string;
  to_profile: string;
  note: string;
  status: RequestStatus;
  created_at: string;
  shifts?: Pick<Shift, 'starts_at' | 'ends_at' | 'area'> | null;
}

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  done_by: string | null;
  done_by_name: string | null;
  done_at: string | null;
}

export type Frequency = 'daily' | 'weekly' | 'monthly';

export interface Checklist {
  id: string;
  name: string;
  kind: 'service' | 'nettoyage';
  frequency: Frequency;
  items: ChecklistItem[];
}

export interface ColdUnit {
  id: string;
  name: string;
  min_temp: number;
  max_temp: number;
  readings_per_day: 1 | 2;
  position: number;
  active: boolean;
}

export interface TempReading {
  id: string;
  unit_id: string;
  value: number;
  day: string;
  slot: 'matin' | 'soir';
  out_of_range: boolean;
  corrective: string;
  taken_by: string | null;
  taken_at: string;
}

export interface TraceItem {
  id: string;
  name: string;
  kind: 'preparation' | 'ouverture';
  made_on: string;
  use_by: string;
  note: string;
  created_by: string | null;
  closed_at: string | null;
  closed_reason: 'utilise' | 'jete' | null;
}

export interface OilLog {
  id: string;
  action: 'test' | 'changement';
  polar_pct: number | null;
  note: string;
  done_by: string | null;
  done_at: string;
}

export interface Supplier {
  id: string;
  name: string;
  contact: string;
  phone: string;
  email: string;
  delivery_days: string;
  order_cutoff: string;
  minimum: string;
  note: string;
  active: boolean;
}

export interface Product {
  id: string;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  threshold: number;
  /** Quantité à retrouver après une commande. Vide : deux fois le seuil. */
  target: number | null;
  unit_price: number;
  supplier_id: string | null;
  active: boolean;
}

export interface OrderLine {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
  received_quantity: number | null;
  products?: Pick<Product, 'name' | 'unit'> | null;
}

export type OrderStatus = 'draft' | 'sent' | 'received' | 'cancelled';

export interface Order {
  id: string;
  supplier_id: string;
  status: OrderStatus;
  note: string;
  created_by: string | null;
  created_at: string;
  sent_by: string | null;
  sent_at: string | null;
  received_by: string | null;
  received_at: string | null;
  reception_ok: boolean | null;
  reception_temp: number | null;
  reception_note: string;
  suppliers?: Pick<Supplier, 'name' | 'phone' | 'email'> | null;
  order_lines: OrderLine[];
}

export type ReservationStatus = 'confirmed' | 'seated' | 'no_show' | 'cancelled';
export type ReservationSource = 'en_ligne' | 'telephone' | 'sur_place' | 'instagram' | 'autre';

export interface Reservation {
  id: string;
  day: string;
  /** Heure d'arrivée, HH:MM:SS. */
  slot: string;
  party: number;
  name: string;
  phone: string;
  email: string;
  note: string;
  table_label: string;
  source: ReservationSource;
  status: ReservationStatus;
  created_by: string | null;
  created_at: string;
}

export interface BookingSettings {
  online_enabled: boolean;
  slot_minutes: number;
  max_party_online: number;
  min_lead_minutes: number;
  max_days_ahead: number;
  capacity_per_slot: number | null;
  phone: string;
  notice: string;
}

export interface OpeningHour {
  /** 1 = lundi … 7 = dimanche. */
  weekday: number;
  open: boolean;
  first_slot: string;
  last_slot: string;
  break_from: string | null;
  break_to: string | null;
}

/** Ce que la page publique de réservation reçoit : aucune donnée de client. */
export interface BookingInfo {
  online_enabled: boolean;
  max_party_online: number;
  max_days_ahead: number;
  phone: string;
  notice: string;
  today: string;
  open_weekdays: number[];
}

/** Ce que renvoie today_tasks : ce qu'il reste à faire pour le jour de service en cours. */
export interface TodayTasks {
  day: string;
  slot: 'matin' | 'soir';
  checks_total: number;
  checks_done: number;
  temps_due: number;
  temps_alerts: number;
  dlc_today: number;
  dlc_late: number;
  /** Présents seulement une fois la migration des stocks exécutée. */
  low_stock?: number;
  deliveries?: number;
  /** Présents seulement une fois la migration des réservations exécutée. */
  bookings?: number;
  covers?: number;
}

export interface Kiosk {
  id: string;
  site_id: string;
  label: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  sites?: Pick<Site, 'name'> | null;
}

/** Ce que renvoient kiosk_code et site_code. */
export interface CodeInfo {
  site_id: string;
  site_name: string;
  code: string;
  seconds_left: number;
}

export type PunchError =
  | 'no_profile' | 'action' | 'too_many' | 'site' | 'code'
  | 'already_in' | 'not_in' | 'stale_closed' | 'already_paused' | 'not_paused';

export type PunchResult =
  | { ok: true; action: string }
  | { ok: false; error: PunchError };

export const STATUS_LABEL: Record<RequestStatus, string> = { pending: 'En attente', approved: 'Acceptée', refused: 'Refusée' };
export const STATUS_PILL: Record<RequestStatus, string> = { pending: 'warn', approved: 'ok', refused: 'bad' };
export const LEAVE_LABEL: Record<LeaveRequest['kind'], string> = { conge: 'Congé', indisponibilite: 'Indisponibilité' };
export const FREQUENCY_LABEL: Record<Frequency, string> = { daily: 'Chaque jour', weekly: 'Chaque semaine', monthly: 'Chaque mois' };
export const PERIOD_NOW: Record<Frequency, string> = { daily: "Aujourd'hui", weekly: 'Cette semaine', monthly: 'Ce mois-ci' };
export const SOURCE_LABEL: Record<ReservationSource, string> = { en_ligne: 'En ligne', telephone: 'Téléphone', sur_place: 'Sur place', instagram: 'Instagram', autre: 'Autre' };
export const WEEKDAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
export const ORDER_LABEL: Record<OrderStatus, string> = { draft: 'Brouillon', sent: 'Envoyée', received: 'Reçue', cancelled: 'Annulée' };
export const ORDER_PILL: Record<OrderStatus, string> = { draft: '', sent: 'info', received: 'ok', cancelled: 'bad' };
/** Quantité à commander pour revenir au niveau voulu. */
export const toOrder = (p: Pick<Product, 'quantity' | 'threshold' | 'target'>) => Math.max(1, Math.ceil((p.target ?? p.threshold * 2) - p.quantity));
export const ROLE_LABEL: Record<Role, string> = { gerant: 'Gérant', responsable: 'Responsable', equipier: 'Équipier' };
export const CONTRACT_LABEL: Record<Contract, string> = { cdi: 'CDI', cdd: 'CDD', extra: 'Extra', autre: 'Autre' };
export const fullName = (p: Pick<Profile, 'first_name' | 'last_name'> | null | undefined) =>
  p ? [p.first_name, p.last_name].filter(Boolean).join(' ') : 'Inconnu';
