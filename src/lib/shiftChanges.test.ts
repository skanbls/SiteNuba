import { describe, expect, it } from 'vitest';
import { netChanges } from './shiftChanges';
import type { ShiftChange } from './types';

const ch = (id: number, kind: ShiftChange['kind'], start: string, emailed_at: string | null = null): ShiftChange =>
  ({ id, kind, emailed_at, starts_at: `2026-12-0${start}T17:00:00Z`, ends_at: `2026-12-0${start}T22:00:00Z`, area: 'Salle', old_starts_at: null, old_ends_at: null, old_area: null, created_at: '' });

describe('changements de planning', () => {
  it('un service ajouté puis retiré ne compte pas ; le dernier état reste', () => {
    const out = netChanges([ch(1, 'added', '1'), ch(2, 'removed', '1'), ch(3, 'added', '2'), ch(4, 'removed', '3'), ch(5, 'added', '3'), ch(6, 'removed', '3'), ch(7, 'changed', '4')]);
    expect(out.map((c) => c.id)).toEqual([3, 6, 7]);
  });

  it("garde un ajout déjà annoncé par e-mail, et le retrait qui suit", () => {
    expect(netChanges([ch(1, 'added', '1', '2026-11-25T10:00:00Z'), ch(2, 'removed', '1')]).map((c) => c.id)).toEqual([1, 2]);
  });
});
