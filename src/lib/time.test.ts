import { describe, expect, it } from 'vitest';
import { addDays, breakMs, fmtDur, periodRange, shiftRange, toCsv, toLocalInput, weekStart, workedMs } from './time';

const H = 3600_000;
const at = (h: number, m = 0) => new Date(2026, 10, 14, h, m).toISOString();
const brk = (a: string, b: string | null) => ({ id: 'b', entry_id: 'e', started_at: a, ended_at: b });

describe('durées', () => {
  it('affiche les heures et les minutes', () => {
    expect(fmtDur(6 * H + 5 * 60_000)).toBe('6 h 05');
    expect(fmtDur(0)).toBe('0 h 00');
    expect(fmtDur(-5)).toBe('0 h 00');
  });
  it('retire les pauses du temps travaillé', () => {
    const e = { clock_in: at(18), clock_out: at(23, 30), time_breaks: [brk(at(20), at(20, 20))] };
    expect(breakMs(e)).toBe(20 * 60_000);
    expect(workedMs(e)).toBe(5.5 * H - 20 * 60_000);
  });
  it('compte une présence et une pause en cours jusqu\'à maintenant', () => {
    const now = new Date(2026, 10, 14, 21).getTime();
    const e = { clock_in: at(18), clock_out: null, time_breaks: [brk(at(20, 30), null)] };
    expect(breakMs(e, now)).toBe(30 * 60_000);
    expect(workedMs(e, now)).toBe(2.5 * H);
  });
  it('traverse minuit', () => {
    const e = { clock_in: at(18), clock_out: new Date(2026, 10, 15, 1).toISOString(), time_breaks: [] };
    expect(workedMs(e)).toBe(7 * H);
  });
});

describe('périodes', () => {
  it('commence la semaine le lundi', () => {
    const { from, to } = periodRange('week', new Date(2026, 10, 15, 22)); // dimanche 15 novembre 2026
    expect([from.getDate(), from.getDay()]).toEqual([9, 1]);
    expect(to.getDate()).toBe(16);
  });
  it('gère le mois dernier en janvier', () => {
    const { from, to } = periodRange('lastMonth', new Date(2027, 0, 10));
    expect([from.getFullYear(), from.getMonth(), to.getMonth()]).toEqual([2026, 11, 0]);
  });
});

describe('export', () => {
  it('protège les points-virgules et les guillemets, et met la virgule décimale', () => {
    const csv = toCsv([['Nom', 'Heures'], ['Martin; "Théo"', 6.5]]);
    expect(csv).toBe('﻿Nom;Heures\r\n"Martin; ""Théo""";6,5\r\n');
  });
  it('formate une date pour un champ date-heure', () => {
    expect(toLocalInput(new Date(2026, 0, 5, 9, 7))).toBe('2026-01-05T09:07');
    expect(toLocalInput(null)).toBe('');
  });
});

describe('planning', () => {
  it('place un service du soir sur deux jours', () => {
    const r = shiftRange('2026-11-20', '18:00', '01:00');
    expect(new Date(r.starts_at)).toEqual(new Date(2026, 10, 20, 18, 0));
    expect(new Date(r.ends_at)).toEqual(new Date(2026, 10, 21, 1, 0));
  });
  it('garde un service de journée sur le même jour', () => {
    const r = shiftRange('2026-11-20', '09:30', '15:00');
    expect(new Date(r.ends_at)).toEqual(new Date(2026, 10, 20, 15, 0));
  });
  it('trouve le lundi, y compris à cheval sur deux mois', () => {
    expect(weekStart(new Date(2026, 11, 3, 14))).toEqual(new Date(2026, 10, 30));
    expect(addDays(new Date(2026, 10, 30), 7)).toEqual(new Date(2026, 11, 7));
  });
  it('garde la même heure en recopiant une semaine au changement d\'heure', () => {
    const before = new Date(2026, 9, 24, 18, 0); // samedi avant le passage à l'heure d'hiver
    expect(addDays(before, 7).getHours()).toBe(18);
  });
});
