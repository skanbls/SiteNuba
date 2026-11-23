import { describe, expect, it } from 'vitest';
import { absenceText, absencesOf, recapRows, weekOf, weeklyMs, type ReportAbsence } from './recap';
import type { TimeEntry } from './types';

const abs = (p: Partial<ReportAbsence> & Pick<ReportAbsence, 'reason' | 'start_date' | 'end_date'>): ReportAbsence =>
  ({ id: Math.random().toString(), profile_id: 'theo', part: 'full', document: false, ...p });
const entry = (id: string, clockIn: string, clockOut: string | null, profile = 'theo', review = false): TimeEntry => ({
  id, profile_id: profile, site_id: null, clock_in: clockIn, clock_out: clockOut, source: 'qr', note: '', needs_review: review,
  profiles: { first_name: profile === 'theo' ? 'Théo' : 'Inès', last_name: profile === 'theo' ? 'Martin' : 'Durand' }, sites: null, time_breaks: [],
} as unknown as TimeEntry);

describe('récap mensuel de la comptable', () => {
  it('compte les jours d\'absence dans le mois, par motif', () => {
    const list = [
      abs({ reason: 'conges_payes', start_date: '2026-10-29', end_date: '2026-11-03' }),        // déborde sur octobre
      abs({ reason: 'maladie', start_date: '2026-11-09', end_date: '2026-11-15', document: true }), // dimanche 15 compris
      abs({ reason: 'conges_payes', start_date: '2026-11-20', end_date: '2026-11-20', part: 'am' }),
      abs({ reason: 'maladie', start_date: '2026-11-01', end_date: '2026-11-02', profile_id: 'ines' }),
    ];
    const r = absencesOf(list, 'theo', '2026-11-01', '2026-11-30');
    expect(r.map((a) => [a.reason, a.days, a.workdays])).toEqual([['conges_payes', 3.5, 2.5], ['maladie', 7, 6]]);
    expect(r[0].ranges).toEqual(['du 01/11 au 03/11', 'le 20/11 (matin)']);
    expect(r[1].document).toBe(true);
    expect(absenceText(r[1])).toBe('7 j, 6 ouvrables · du 09/11 au 15/11');
  });

  it('range les heures par semaine, du lundi au dimanche (heure de Paris)', () => {
    expect(weekOf('2026-11-08T22:30:00Z')).toBe('2026-11-02');   // dimanche 23 h 30 à Paris
    expect(weekOf('2026-11-08T23:30:00Z')).toBe('2026-11-09');   // lundi 0 h 30 à Paris
    const w = weeklyMs([entry('1', '2026-11-03T09:00:00Z', '2026-11-03T17:00:00Z'), entry('2', '2026-11-10T09:00:00Z', '2026-11-10T13:00:00Z'), entry('3', '2026-11-11T09:00:00Z', null)], 'theo');
    expect([...w.entries()]).toEqual([['2026-11-02', 8 * 3600000], ['2026-11-09', 4 * 3600000]]);
  });

  it('fabrique le fichier : une ligne par personne, les absences en colonnes, puis les semaines', () => {
    const people = [{ id: 'theo', first_name: 'Théo', last_name: 'Martin', contract: 'cdi', weekly_hours: 35 }, { id: 'ines', first_name: 'Inès', last_name: 'Durand', contract: 'cdd', weekly_hours: 20 }, { id: 'zoe', first_name: 'Zoé', last_name: 'Absente', contract: 'cdi', weekly_hours: 35 }];
    const entries = [entry('1', '2026-11-03T09:00:00Z', '2026-11-03T17:30:00Z'), entry('2', '2026-11-04T09:00:00Z', '2026-11-04T12:00:00Z', 'theo', true)];
    const absences = [abs({ reason: 'maladie', start_date: '2026-11-09', end_date: '2026-11-10', profile_id: 'ines', document: true })];
    const rows = recapRows(people, entries, absences, '2026-11-01', '2026-11-30', (c) => c.toUpperCase());
    expect(rows[0]).toEqual(['Récapitulatif du 01/11/2026 au 30/11/2026']);
    expect(rows[2]).toEqual(['Nom', 'Prénom', 'Contrat', 'Heures par semaine au contrat', 'Heures travaillées (décimal)', 'Temps travaillé', 'Jours travaillés', 'Pointages à vérifier',
      'Arrêt maladie (jours calendaires)', 'Arrêt maladie (jours ouvrables)', 'Absences (dates)', 'Justificatif reçu']);
    expect(rows[3]).toEqual(['Martin', 'Théo', 'CDI', 35, 11.5, '11 h 30', 2, 1, '', '', '', '']);
    expect(rows[4]).toEqual(['Durand', 'Inès', 'CDD', 20, 0, '0 h 00', 0, 0, 2, 2, 'Arrêt maladie : du 09/11 au 10/11', 'oui']);
    expect(rows.some((r) => r[0] === 'Absente')).toBe(false);   // ni heures ni absences : pas de ligne
    expect(rows.slice(-4)).toEqual([['Heures par semaine (semaine du lundi…)'], ['Nom', 'Prénom', '02/11/2026'], ['Martin', 'Théo', 11.5], ['Durand', 'Inès', '']]);
  });
});
