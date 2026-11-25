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
  /** Migration 0027 : 'sheet' quand le service vient de l'onglet « Planning équipe » du fichier tableau de bord. */
  source?: 'app' | 'sheet';
}

/** Migration 0027 : un service ajouté, modifié ou retiré, montré à la personne jusqu'à « C'est noté ». */
export interface ShiftChange {
  id: number;
  kind: 'added' | 'changed' | 'removed';
  starts_at: string;
  ends_at: string;
  area: string;
  old_starts_at: string | null;
  old_ends_at: string | null;
  old_area: string | null;
  created_at: string;
  /** L'e-mail récapitulatif est parti (ou a été préparé). */
  emailed_at: string | null;
}

export type RequestStatus = 'pending' | 'approved' | 'refused';

/** Motif d'une absence (migration 0020), comme dans les logiciels de planning. */
export type LeaveReason =
  | 'conges_payes' | 'recuperation' | 'ferie' | 'maladie' | 'accident_travail' | 'enfant_malade' | 'maternite'
  | 'paternite' | 'parental' | 'evenement_familial' | 'formation' | 'absence_autorisee' | 'sans_solde'
  | 'absence_injustifiee' | 'mise_a_pied' | 'autre';
export type LeavePart = 'full' | 'am' | 'pm';

export interface LeaveRequest {
  id: string;
  profile_id: string;
  kind: 'conge' | 'indisponibilite';
  start_date: string;
  end_date: string;
  note: string;
  status: RequestStatus;
  created_at: string;
  /** Absent pour les absences des collègues : le motif ne regarde pas l'équipe. */
  reason?: LeaveReason;
  part?: LeavePart;
  document_id?: string | null;
}

/** Motifs d'absence : libellé, abréviation du planning, et si chacun peut le demander lui-même. */
export const ABSENCE_REASONS: { key: LeaveReason; label: string; short: string; ask: boolean }[] = [
  { key: 'conges_payes', label: 'Congés payés', short: 'CP', ask: true },
  { key: 'recuperation', label: 'Récupération (repos compensateur)', short: 'Récup', ask: true },
  { key: 'ferie', label: 'Jour férié chômé', short: 'Férié', ask: false },
  { key: 'maladie', label: 'Arrêt maladie', short: 'Maladie', ask: false },
  { key: 'accident_travail', label: 'Accident du travail ou de trajet', short: 'AT', ask: false },
  { key: 'enfant_malade', label: 'Enfant malade', short: 'Enf. malade', ask: true },
  { key: 'maternite', label: 'Congé maternité', short: 'Maternité', ask: true },
  { key: 'paternite', label: "Congé paternité et d'accueil de l'enfant", short: 'Paternité', ask: true },
  { key: 'parental', label: 'Congé parental', short: 'Parental', ask: true },
  { key: 'evenement_familial', label: 'Événement familial (mariage, naissance, décès)', short: 'Évén. familial', ask: true },
  { key: 'formation', label: 'Formation ou école', short: 'Formation', ask: true },
  { key: 'absence_autorisee', label: 'Absence autorisée', short: 'Abs. autorisée', ask: true },
  { key: 'sans_solde', label: 'Congé sans solde', short: 'Sans solde', ask: true },
  { key: 'absence_injustifiee', label: 'Absence injustifiée', short: 'Abs. injustifiée', ask: false },
  { key: 'mise_a_pied', label: 'Mise à pied', short: 'Mise à pied', ask: false },
  { key: 'autre', label: 'Autre absence', short: 'Absence', ask: true },
];
export const REASON_LABEL = Object.fromEntries(ABSENCE_REASONS.map((r) => [r.key, r.label])) as Record<LeaveReason, string>;
export const REASON_SHORT = Object.fromEntries(ABSENCE_REASONS.map((r) => [r.key, r.short])) as Record<LeaveReason, string>;
export const PART_LABEL: Record<LeavePart, string> = { full: 'Journée', am: 'Matin', pm: 'Après-midi' };

/** Documents de l'équipe (migration 0020). */
export type DocCategory =
  | 'arret' | 'accident' | 'justificatif' | 'identite' | 'sejour' | 'vitale' | 'rib' | 'mutuelle'
  | 'medecine' | 'diplome' | 'dpae' | 'contrat' | 'paie' | 'autre';
export interface StaffDocument {
  id: string;
  profile_id: string;
  category: DocCategory;
  title: string;
  file_path: string;
  file_name: string;
  mime: string;
  size_bytes: number | null;
  start_date: string | null;
  end_date: string | null;
  note: string;
  uploaded_by: string | null;
  /** Migration 0021 : la comptable qui l'a déposé (bulletins de paie). */
  accountant_id?: string | null;
  created_at: string;
}
/** Catégories : libellé, groupe, et si la personne l'envoie elle-même (sinon le gérant). */
export const DOC_CATEGORIES: { key: DocCategory; label: string; group: string; self: boolean; dates?: boolean; month?: boolean }[] = [
  { key: 'arret', label: 'Arrêt de travail (maladie)', group: 'Absences', self: true, dates: true },
  { key: 'accident', label: 'Accident du travail ou de trajet', group: 'Absences', self: true, dates: true },
  { key: 'justificatif', label: "Justificatif d'absence", group: 'Absences', self: true, dates: true },
  { key: 'identite', label: "Pièce d'identité (carte ou passeport)", group: 'Identité et embauche', self: true },
  { key: 'sejour', label: 'Titre de séjour', group: 'Identité et embauche', self: true },
  { key: 'vitale', label: 'Carte Vitale ou attestation de sécurité sociale', group: 'Identité et embauche', self: true },
  { key: 'rib', label: 'RIB', group: 'Identité et embauche', self: true },
  { key: 'mutuelle', label: 'Mutuelle (adhésion ou dispense)', group: 'Identité et embauche', self: true },
  { key: 'medecine', label: 'Visite médicale (médecine du travail)', group: 'Identité et embauche', self: true },
  { key: 'diplome', label: 'Diplôme ou attestation de formation', group: 'Identité et embauche', self: true },
  { key: 'dpae', label: 'DPAE', group: 'Employeur', self: false },
  { key: 'contrat', label: 'Contrat de travail ou avenant', group: 'Employeur', self: true },
  { key: 'paie', label: 'Bulletin de paie', group: 'Paie', self: false, month: true },
  { key: 'autre', label: 'Autre document', group: 'Autre', self: true },
];
export const DOC_LABEL = Object.fromEntries(DOC_CATEGORIES.map((c) => [c.key, c.label])) as Record<DocCategory, string>;

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
  /** Migration 0025 : poste (Salle, Bar…), '' pour toute l'équipe au planning. */
  area?: string;
  /** Jour prévu : 1 = lundi … 7 = dimanche ; pour le mois, rang 1 à 4 ou 5 (le dernier). */
  due_weekday?: number | null;
  due_week?: number | null;
  /** Jour prévu dans la période en cours, et prochain jour prévu à partir d'aujourd'hui (AAAA-MM-JJ). */
  due?: string | null;
  next_due?: string | null;
  /** La liste concerne la personne aujourd'hui, demain (d'après son planning). */
  mine?: boolean;
  mine_tomorrow?: boolean;
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

/** pending : demande à valider (0022) ; declined : demande refusée (0022). */
export type ReservationStatus = 'pending' | 'confirmed' | 'seated' | 'no_show' | 'cancelled' | 'declined';
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
  /** Migration 0022 : rappel de la veille envoyé. */
  reminded_at?: string | null;
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
  /** Migration 0022 : à partir de combien de personnes une réservation en ligne est une demande à valider (null : jamais). */
  review_from?: number | null;
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
  /** Migration 0022 : seuil des demandes à valider (null : jamais). */
  review_from?: number | null;
}

export type CustomerKind = 'particulier' | 'entreprise' | 'artiste' | 'prestataire';

export interface Customer {
  id: string;
  name: string;
  kind: CustomerKind;
  company: string;
  phone: string;
  email: string;
  note: string;
  active: boolean;
}

/** soiree : migration 0024 (quiz, DJ set, soirée à thème…). */
export type EventKind = 'privatisation' | 'soiree' | 'concert' | 'exposition' | 'exterieur';
export type EventStatus = 'demande' | 'devis' | 'acompte' | 'confirme' | 'termine' | 'annule';

export interface EventTask {
  id: string;
  event_id: string;
  label: string;
  position: number;
  done_by: string | null;
  done_at: string | null;
}

export interface NubaEvent {
  id: string;
  kind: EventKind;
  title: string;
  day: string;
  end_day: string | null;
  start_time: string | null;
  guests: number | null;
  status: EventStatus;
  customer_id: string | null;
  site_id: string | null;
  amount: number | null;
  deposit: number | null;
  deposit_paid: boolean;
  details: string;
  note: string;
  /** site : vient du fichier « Contenu du site » (migration 0024). */
  source: 'equipe' | 'en_ligne' | 'site';
  /** Migration 0024 : type écrit dans le fichier (« DJ set »), horaire, entrée, lien de l'affiche. */
  category?: string;
  schedule?: string;
  entry?: string;
  poster_url?: string;
  event_tasks: EventTask[];
}

/** Un rendez-vous de chaque semaine (onglet « Chaque semaine » du fichier du site, migration 0024). */
export interface SiteWeekly {
  position: number;
  /** 1 = lundi … 7 = dimanche, ou null (« Tous les jours »). */
  weekday: number | null;
  day_label: string;
  title: string;
  schedule: string;
}

export interface RecipeItem {
  id: string;
  recipe_id: string;
  product_id: string | null;
  label: string;
  quantity: number;
  unit: string;
  /** Nombre d'unités de la recette dans une unité du produit (70 cl dans une bouteille de 70 cl). */
  pack_size: number;
  manual_cost: number | null;
  position: number;
}

export interface Recipe {
  id: string;
  name: string;
  category: string;
  portions: number;
  /** Prix de vente TTC d'une portion. */
  sale_price: number | null;
  vat: number;
  method: string;
  allergens: string[];
  active: boolean;
  recipe_items: RecipeItem[];
}

export interface Issue {
  id: string;
  title: string;
  place: string;
  details: string;
  urgent: boolean;
  status: 'open' | 'doing' | 'done';
  resolution: string;
  reported_by: string | null;
  reported_at: string;
  closed_by: string | null;
  closed_at: string | null;
}

export type DeadlineCategory = 'controle' | 'contrat' | 'document' | 'autre';

export interface Deadline {
  id: string;
  title: string;
  category: DeadlineCategory;
  due_date: string;
  repeat_months: number | null;
  profile_id: string | null;
  note: string;
  active: boolean;
}

export interface Procedure {
  id: string;
  title: string;
  category: string;
  body: string;
  must_read: boolean;
  position: number;
  active: boolean;
  updated_at: string;
}

export interface ProcedureRead {
  procedure_id: string;
  profile_id: string;
  read_at: string;
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
  /** Présents seulement une fois la migration des événements exécutée. */
  events_today?: { id: string; kind: EventKind; title: string; start_time: string | null; guests: number | null }[];
  event_requests?: number;
  /** Présents seulement une fois la migration du pilotage exécutée. */
  issues_open?: number;
  issues_urgent?: number;
  procedures_unread?: number;
  /** Réservé au gérant : échéances dépassées ou dans les 30 jours. */
  deadlines_due?: number | null;
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
/** Les 14 allergènes à déclarer. */
export const ALLERGENS = ['gluten', 'crustacés', 'œufs', 'poissons', 'arachides', 'soja', 'lait', 'fruits à coque', 'céleri', 'moutarde', 'sésame', 'sulfites', 'lupin', 'mollusques'];
export const DEADLINE_LABEL: Record<DeadlineCategory, string> = { controle: 'Contrôle obligatoire', contrat: 'Contrat', document: "Document d'un membre de l'équipe", autre: 'Autre' };
export const CUSTOMER_KIND: Record<CustomerKind, string> = { particulier: 'Particulier', entreprise: 'Entreprise', artiste: 'Artiste', prestataire: 'Prestataire' };
export const EVENT_KIND: Record<EventKind, string> = { privatisation: 'Privatisation', soiree: 'Soirée', concert: 'Concert', exposition: 'Exposition', exterieur: 'Hors les murs' };
export const EVENT_STATUS: Record<EventStatus, string> = { demande: 'Demande', devis: 'Devis envoyé', acompte: 'Acompte reçu', confirme: 'Confirmé', termine: 'Terminé', annule: 'Annulé' };
export const EVENT_PILL: Record<EventStatus, string> = { demande: 'info', devis: 'warn', acompte: 'info', confirme: 'ok', termine: '', annule: 'bad' };
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

export interface EmailSettings {
  enabled: boolean;
  sender_name: string;
  sender_email: string;
  notify_email: string;
  app_url: string;
  signature: string;
  confirm_booking: boolean;
  notify_booking: boolean;
  notify_event: boolean;
  /** Migration 0020 : absent avant. */
  notify_documents?: boolean;
  /** Migration 0021 : absent avant. */
  notify_payslips?: boolean;
  /** Migration 0022 : rappel la veille aux clients. */
  remind_booking?: boolean;
  /** Migration 0025 : rappel la veille des tâches de la semaine et du mois. */
  remind_tasks?: boolean;
  /** Migrations 0026 et 0027 : récapitulatif de la caisse au gérant, e-mail à chacun quand son planning change. */
  notify_closing?: boolean;
  notify_planning?: boolean;
}

export interface EmailLogEntry {
  id: number;
  kind: string;
  to: string;
  subject: string;
  status: 'queued' | 'sent' | 'accepted' | 'failed';
  error: string;
  at: string;
}

export type ContactCategory = 'urgence' | 'equipe' | 'depannage' | 'fournisseur' | 'administratif' | 'autre';
export const CONTACT_CATEGORY: Record<ContactCategory, string> = {
  urgence: 'Urgences', equipe: 'Équipe', depannage: 'Dépannage', fournisseur: 'Fournisseurs', administratif: 'Administratif', autre: 'Autres',
};
export interface Contact {
  id: string;
  category: ContactCategory;
  name: string;
  phone: string;
  note: string;
  urgent: boolean;
  position: number;
  updated_by: string | null;
  updated_at: string;
}

/** Accès comptable : heures travaillées seulement. */
export interface AccountantAccess { id: string; email: string; name: string; user_id: string | null; active: boolean; created_at: string; last_seen_at: string | null }
