/**
 * Récap mensuel pour la comptable : heures travaillées, heures par semaine, absences par motif.
 * Les absences arrivent de hours_report, acceptées seulement, sans les notes.
 */
import { fmtDur, workedMs } from './time';
import { ABSENCE_REASONS, REASON_LABEL, type LeavePart, type LeaveReason, type TimeEntry } from './types';

export interface ReportAbsence { id: string; profile_id: string; reason: LeaveReason; start_date: string; end_date: string; part: LeavePart; document: boolean }
export interface AbsenceSum {
  reason: LeaveReason;
  /** Jours calendaires dans la période (une demi-journée compte 0,5). */
  days: number;
  /** Jours ouvrables, du lundi au samedi (dimanches retirés). */
  workdays: number;
  ranges: string[];
  document: boolean;
}

const DAY = 86400000;
const utc = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
const ddmm = (t: number) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const fr = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

/** Les absences d'une personne sur la période, additionnées par motif, dans l'ordre des motifs. */
export function absencesOf(list: ReportAbsence[], profileId: string, from: string, to: string): AbsenceSum[] {
  const lo = utc(from), hi = utc(to);
  const m = new Map<LeaveReason, AbsenceSum>();
  for (const a of list) {
    if (a.profile_id !== profileId) continue;
    const s = Math.max(utc(a.start_date), lo), e = Math.min(utc(a.end_date), hi);
    if (e < s) continue;
    const half = a.part !== 'full' ? 0.5 : 1;
    let days = 0, workdays = 0;
    for (let t = s; t <= e; t += DAY) {
      days += half;
      if (new Date(t).getUTCDay() !== 0) workdays += half;
    }
    const cur = m.get(a.reason) ?? { reason: a.reason, days: 0, workdays: 0, ranges: [], document: false };
    cur.days += days;
    cur.workdays += workdays;
    cur.ranges.push(s === e ? `le ${ddmm(s)}${a.part === 'am' ? ' (matin)' : a.part === 'pm' ? ' (après-midi)' : ''}` : `du ${ddmm(s)} au ${ddmm(e)}`);
    cur.document ||= a.document;
    m.set(a.reason, cur);
  }
  return ABSENCE_REASONS.map((r) => m.get(r.key)).filter((x): x is AbsenceSum => !!x);
}

/** Lundi (heure de Paris) de la semaine d'une date, en AAAA-MM-JJ. */
export function weekOf(iso: string): string {
  const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Temps travaillé par semaine (lundi), pointages terminés seulement. */
export function weeklyMs(entries: TimeEntry[], profileId: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    if (e.profile_id !== profileId || !e.clock_out) continue;
    const w = weekOf(e.clock_in);
    m.set(w, (m.get(w) ?? 0) + workedMs(e));
  }
  return m;
}

export interface RecapPerson { id: string; first_name: string; last_name: string; contract: string; weekly_hours: number }

/** Le fichier du récap : une ligne par personne, puis les heures par semaine. */
export function recapRows(people: RecapPerson[], entries: TimeEntry[], absences: ReportAbsence[], from: string, to: string, contractLabel: (c: string) => string): (string | number)[][] {
  const reasons = ABSENCE_REASONS.filter((r) => absences.some((a) => a.reason === r.key)).map((r) => r.key);
  const weeks = Array.from(new Set(entries.filter((e) => e.clock_out).map((e) => weekOf(e.clock_in)))).sort();
  const rows: (string | number)[][] = [
    [`Récapitulatif du ${from.split('-').reverse().join('/')} au ${to.split('-').reverse().join('/')}`],
    [],
    ['Nom', 'Prénom', 'Contrat', 'Heures par semaine au contrat', 'Heures travaillées (décimal)', 'Temps travaillé', 'Jours travaillés', 'Pointages à vérifier',
      ...reasons.flatMap((r) => [`${REASON_LABEL[r]} (jours calendaires)`, `${REASON_LABEL[r]} (jours ouvrables)`]), 'Absences (dates)', 'Justificatif reçu'],
  ];
  const shown = people.filter((p) => entries.some((e) => e.profile_id === p.id) || absences.some((a) => a.profile_id === p.id));
  for (const p of shown) {
    const mine = entries.filter((e) => e.profile_id === p.id && e.clock_out);
    const ms = mine.reduce((t, e) => t + workedMs(e), 0);
    const days = new Set(mine.map((e) => e.clock_in.slice(0, 10))).size;
    const abs = absencesOf(absences, p.id, from, to);
    rows.push([
      p.last_name, p.first_name, contractLabel(p.contract), p.weekly_hours, Math.round(ms / 36000) / 100, fmtDur(ms), days,
      entries.filter((e) => e.profile_id === p.id && e.needs_review).length,
      ...reasons.flatMap((r): (string | number)[] => { const a = abs.find((x) => x.reason === r); return a ? [a.days, a.workdays] : ['', '']; }),
      abs.map((a) => `${REASON_LABEL[a.reason]} : ${a.ranges.join(', ')}`).join(' ; '),
      abs.some((a) => a.document) ? 'oui' : '',
    ]);
  }
  if (weeks.length) {
    rows.push([], ['Heures par semaine (semaine du lundi…)'], ['Nom', 'Prénom', ...weeks.map((w) => w.split('-').reverse().join('/'))]);
    for (const p of shown) {
      const w = weeklyMs(entries, p.id);
      rows.push([p.last_name, p.first_name, ...weeks.map((k) => (w.has(k) ? Math.round((w.get(k) ?? 0) / 36000) / 100 : ''))]);
    }
  }
  return rows;
}

/** Résumé lisible d'une absence additionnée : « 3 j (du 03/11 au 05/11) ». */
export const absenceText = (a: AbsenceSum) => `${fr(a.days)} j${a.workdays !== a.days ? `, ${fr(a.workdays)} ouvrable${a.workdays > 1 ? 's' : ''}` : ''} · ${a.ranges.join(', ')}`;

