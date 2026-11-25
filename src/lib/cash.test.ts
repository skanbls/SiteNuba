import { describe, expect, it } from 'vitest';
import { calc, cashStats, cashTotal, closingsCsv, maxGap, num, type CashClosing } from './cash';

const blank = { counts: {}, expenses: [], float_start: '', float_end: '', z_cash: '', z_card: '', z_meal: '', z_cheque: '', card_counted: '', meal_counted: '', cheque_counted: '' };

describe('fermeture de caisse', () => {
  it('compte les espèces et calcule les écarts comme la base', () => {
    expect(num('12,50')).toBe(12.5);
    expect(num('')).toBeNull();
    expect(cashTotal({ 5000: '4', 2000: 5, 1000: '3', 500: 1, 200: 1, 50: '1' })).toBe(337.5);
    expect(cashTotal({})).toBeNull();
    const c = calc({ ...blank, counts: { 5000: 4, 2000: 5, 1000: 3, 500: 1, 200: 1, 50: 1 }, expenses: [{ amount: '12,5' }],
      float_start: '150', z_cash: '200', float_end: '150', z_card: '700', card_counted: '699', z_meal: '100', meal_counted: '' });
    expect(c).toMatchObject({ counted: 337.5, expenses: 12.5, expected: 337.5, cashGap: 0, cardGap: -1, mealGap: null, deposit: 187.5 });
    expect(maxGap(c)).toBe(1);
  });

  it('fait les chiffres du tableau de bord', () => {
    const mk = (day: string, z: number, covers = 10, status: 'closed' | 'draft' = 'closed') => ({ day, status, z_total: z, z_covers: covers, z_card: z / 2, z_cash: z / 4, z_meal: 0, z_cheque: 0, z_other: 0, cash_gap: -1 } as unknown as CashClosing);
    const s = cashStats([mk('2026-11-24', 1000), mk('2026-11-20', 500), mk('2026-11-12', 300), mk('2026-10-20', 800), mk('2026-11-25', 9999, 1, 'draft')], '2026-11-25');
    expect(s.last?.day).toBe('2026-11-24');
    expect(s.week).toEqual({ ca: 1500, covers: 20, days: 2, previous: 300 });
    expect(s.month).toMatchObject({ ca: 1800, days: 3, previousSamePeriod: 800, card: 900, gaps: -3 });
    expect(s.series.labels).toHaveLength(30);
    expect(s.series.ca[28]).toBe(1000);   // le 24
    expect(s.series.ca[29]).toBeNull();   // brouillon du 25
  });

  it('exporte un mois en CSV pour la comptable', () => {
    const csv = closingsCsv([{ day: '2026-11-24', z_number: 'Z-1', z_total: 1234.5, note: 'Rendu ; erreur\nde monnaie', closed_by: 'p1' } as unknown as CashClosing], new Map([['p1', 'Théo']]));
    const [head, row] = csv.split('\r\n');
    expect(head.startsWith('Jour;N° de Z;CA TTC')).toBe(true);
    expect(row).toContain('2026-11-24;Z-1;1234,5;');
    expect(row).toContain(';Théo;Rendu erreur de monnaie');
  });
});
