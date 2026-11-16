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
    const from = new Date(y, m, now.getDate() - ((now.getDay() + 6) % 7));
    return { from, to: new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7) };
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
