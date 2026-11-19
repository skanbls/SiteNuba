import { breakMs, dayKey, fmtDate, fmtDur, fmtTime, toCsv, workedMs } from './time';
import { fullName, type TimeEntry } from './types';

export interface PersonTotal { id: string; name: string; ms: number; n: number; flags: number; days: number }

/** Temps travaillé par personne, triés par nom. `closedOnly` : sans les présences en cours (fichier, paie). */
export function totalsOf(list: TimeEntry[], now = Date.now(), closedOnly = false): PersonTotal[] {
  const m = new Map<string, PersonTotal & { seen: Set<string> }>();
  for (const e of list) {
    if (closedOnly && !e.clock_out) continue;
    const t = m.get(e.profile_id) ?? { id: e.profile_id, name: fullName(e.profiles), ms: 0, n: 0, flags: 0, days: 0, seen: new Set<string>() };
    t.ms += workedMs(e, now);
    t.n += 1;
    if (e.needs_review) t.flags += 1;
    t.seen.add(dayKey(e.clock_in));
    t.days = t.seen.size;
    m.set(e.profile_id, t);
  }
  return [...m.values()].map(({ seen: _seen, ...t }) => t).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Lignes du fichier pour le comptable : un pointage par ligne, puis le total par personne. */
export function hoursRows(list: TimeEntry[], now = Date.now()): (string | number)[][] {
  const rows: (string | number)[][] = [['Nom', 'Date', 'Arrivée', 'Départ', 'Pause (min)', 'Temps travaillé', 'Heures (décimal)', 'Lieu', 'Saisie', 'Note']];
  const sorted = [...list].sort((a, b) => fullName(a.profiles).localeCompare(fullName(b.profiles), 'fr') || a.clock_in.localeCompare(b.clock_in));
  for (const e of sorted) {
    const done = !!e.clock_out;
    rows.push([
      fullName(e.profiles), fmtDate(e.clock_in), fmtTime(e.clock_in), done ? fmtTime(e.clock_out!) : 'en cours',
      Math.round(breakMs(e, now) / 60000), done ? fmtDur(workedMs(e)) : '', done ? Math.round(workedMs(e) / 36000) / 100 : '',
      e.sites?.name ?? '', e.source === 'qr' ? 'QR code' : e.source === 'borne' ? 'Borne, code PIN' : 'Manuelle', (e.needs_review ? 'À corriger. ' : '') + (e.note ?? ''),
    ]);
  }
  rows.push([], ['Total par personne', '', '', '', '', 'Temps travaillé', 'Heures (décimal)']);
  for (const t of totalsOf(list, now, true)) rows.push([t.name, '', '', '', '', fmtDur(t.ms), Math.round(t.ms / 36000) / 100]);
  return rows;
}

/** Télécharge un fichier CSV lisible par Excel. */
export function downloadCsv(rows: (string | number)[][], filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
