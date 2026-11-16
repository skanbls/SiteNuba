export type Role = 'gerant' | 'responsable' | 'equipier';
export type Contract = 'cdi' | 'cdd' | 'extra' | 'autre';

export interface Profile {
  id: string;
  user_id: string | null;
  email: string;
  first_name: string;
  last_name: string;
  role: Role;
  job: string;
  contract: Contract;
  weekly_hours: number;
  active: boolean;
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
  source: 'qr' | 'manuel';
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
export const ROLE_LABEL: Record<Role, string> = { gerant: 'Gérant', responsable: 'Responsable', equipier: 'Équipier' };
export const CONTRACT_LABEL: Record<Contract, string> = { cdi: 'CDI', cdd: 'CDD', extra: 'Extra', autre: 'Autre' };
export const fullName = (p: Pick<Profile, 'first_name' | 'last_name'> | null | undefined) =>
  p ? [p.first_name, p.last_name].filter(Boolean).join(' ') : 'Inconnu';
