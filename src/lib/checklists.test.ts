import { describe, expect, it } from 'vitest';
import { dueLabel, forMeToday, forMeTomorrow, isLate, whenLabel } from './checklists';
import type { Checklist } from './types';

const list = (p: Partial<Checklist>): Checklist => ({ id: 'x', name: 'Liste', kind: 'service', frequency: 'daily', items: [{ id: 'a', label: 'A', done: false, done_by: null, done_by_name: null, done_at: null }], ...p });
const done = { items: [{ id: 'a', label: 'A', done: true, done_by: null, done_by_name: null, done_at: null }] };

describe('checklists selon le planning', () => {
  it('dit quand et pour qui', () => {
    expect(dueLabel(list({ frequency: 'weekly', due_weekday: 2 }))).toBe('le mardi');
    expect(dueLabel(list({ frequency: 'monthly', due_weekday: 1, due_week: 1 }))).toBe('le 1er lundi du mois');
    expect(dueLabel(list({ frequency: 'monthly', due_weekday: 5, due_week: 5 }))).toBe('le dernier vendredi du mois');
    expect(dueLabel(list({ frequency: 'weekly' }))).toBe('');
    expect(whenLabel(list({ frequency: 'weekly', due_weekday: 2, area: 'Salle' }))).toBe('Chaque semaine, le mardi · Salle');
    expect(whenLabel(list({ area: '' }))).toBe("Chaque jour · toute l'équipe au planning");
  });

  it("montre à chacun ce qu'il a à faire aujourd'hui", () => {
    const today = '2026-11-24';
    expect(forMeToday(list({ mine: true }), today)).toBe(true);
    expect(forMeToday(list({ mine: false }), today)).toBe(false);
    // De la semaine, prévue mardi : le mardi, et en retard ensuite tant qu'elle n'est pas faite.
    const weekly = { frequency: 'weekly' as const, due_weekday: 2, mine: true };
    expect(forMeToday(list({ ...weekly, due: '2026-11-24', next_due: '2026-11-24' }), today)).toBe(true);
    expect(forMeToday(list({ ...weekly, due: '2026-11-24', next_due: '2026-12-01' }), '2026-11-26')).toBe(true);
    expect(isLate(list({ ...weekly, due: '2026-11-24' }), '2026-11-26')).toBe(true);
    expect(forMeToday(list({ ...weekly, ...done, due: '2026-11-24', next_due: '2026-12-01' }), '2026-11-26')).toBe(false);
    expect(forMeToday(list({ ...weekly, due_weekday: 4, due: '2026-11-26', next_due: '2026-11-26' }), today)).toBe(false);
    // Sans jour prévu : tant qu'elle n'est pas finie.
    expect(forMeToday(list({ frequency: 'monthly', mine: true }), today)).toBe(true);
    expect(forMeToday(list({ frequency: 'monthly', mine: true, ...done }), today)).toBe(false);
  });

  it('rappelle la veille ce qui est prévu demain', () => {
    expect(forMeTomorrow(list({ frequency: 'weekly', due_weekday: 3, next_due: '2026-11-25', mine_tomorrow: true }), '2026-11-25')).toBe(true);
    expect(forMeTomorrow(list({ frequency: 'weekly', due_weekday: 3, next_due: '2026-11-25', mine_tomorrow: false }), '2026-11-25')).toBe(false);
    expect(forMeTomorrow(list({ frequency: 'daily', mine_tomorrow: true }), '2026-11-25')).toBe(false);
  });
});
