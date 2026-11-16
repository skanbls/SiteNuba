import type { TimeEntry } from './types';

const pad = (n: number) => String(n).padStart(2, '0');

export const fmtTime = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
export const fmtDay = (iso: string | Date) =>
  new Date(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtDayLong = (iso: string | Date) =>
  new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtDate = (iso: string | Date) => new Date(iso).toLocaleDateString('fr-FR');
export const dayKey = (iso: string | Date) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
/** Lundi de la semaine de `d`, à minuit, en heure locale. */
export const weekStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
/** Date locale à partir d'un jour AAAA-MM-JJ (sans décalage de fuseau). */
export const fromDayKey = (k: string) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const fmtDateShort = (d: Date | string) =>
  (typeof d === 'string' ? fromDayKey(d) : d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
/** Heure locale HH:MM, pour <input type="time">. */
export const timeInput = (iso: string | Date) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Début et fin d'un service à partir d'un jour (AAAA-MM-JJ) et de deux heures (HH:MM).
 * Une fin avant ou égale au début tombe le lendemain : 18:00 → 01:00 finit à 1 h du matin.
 */
export function shiftRange(day: string, start: string, end: string): { starts_at: string; ends_at: string } {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const a = fromDayKey(day);
  a.setHours(sh, sm, 0, 0);
  const b = fromDayKey(day);
  b.setHours(eh, em, 0, 0);
  if (b <= a) b.setDate(b.getDate() + 1);
  return { starts_at: a.toISOString(), ends_at: b.toISOString() };
}

/** Durée lisible : 6 h 05. */
export function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${Math.floor(m / 60)} h ${pad(m % 60)}`;
}

/** Pauses d'un pointage, en millisecondes. Une pause en cours compte jusqu'à `now`. */
export function breakMs(e: Pick<TimeEntry, 'time_breaks' | 'clock_out'>, now = Date.now()): number {
  const end = e.clock_out ? new Date(e.clock_out).getTime() : now;
  return (e.time_breaks || []).reduce((s, b) => {
    const a = new Date(b.started_at).getTime();
    const z = b.ended_at ? new Date(b.ended_at).getTime() : end;
    return s + Math.max(0, z - a);
  }, 0);
}

/** Temps travaillé : présence moins pauses. Une présence en cours compte jusqu'à `now`. */
export function workedMs(e: Pick<TimeEntry, 'clock_in' | 'clock_out' | 'time_breaks'>, now = Date.now()): number {
  const end = e.clock_out ? new Date(e.clock_out).getTime() : now;
  return Math.max(0, end - new Date(e.clock_in).getTime() - breakMs(e, now));
}

export type Period = 'week' | 'month' | 'lastMonth';
export const PERIOD_LABEL: Record<Period, string> = { week: 'Cette semaine', month: 'Ce mois', lastMonth: 'Mois dernier' };

/** Bornes d'une période, en heure locale. `to` est exclu. La semaine commence le lundi. */
export function periodRange(p: Period, now = new Date()): { from: Date; to: Date } {
  const y = now.getFullYear(), m = now.getMonth();
  if (p === 'week') {
    const from = weekStart(now);
    return { from, to: addDays(from, 7) };
  }
  if (p === 'month') return { from: new Date(y, m, 1), to: new Date(y, m + 1, 1) };
  return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) };
}

/** Pour <input type="datetime-local"> : AAAA-MM-JJTHH:MM en heure locale. */
export function toLocalInput(iso: string | Date | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v: string): string | null => (v ? new Date(v).toISOString() : null);

/** CSV lisible par Excel en français : point-virgule, guillemets doublés, BOM. */
export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = typeof v === 'number' ? String(v).replace('.', ',') : v;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}
