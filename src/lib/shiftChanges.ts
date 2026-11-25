import type { ShiftChange } from './types';

/**
 * Les changements à montrer, comme dans l'e-mail (send_shift_notices, migration 0027) : un même service ajouté puis
 * retiré (ou l'inverse) avant tout e-mail ne compte pas ; s'il a bougé plusieurs fois, seul son dernier état est dit.
 * Un changement déjà annoncé par e-mail reste affiché, pour que la suite se comprenne.
 */
export function netChanges(list: ShiftChange[]): ShiftChange[] {
  const slot = (c: ShiftChange) => `${c.starts_at}|${c.ends_at}`;
  const bySlot = new Map<string, ShiftChange[]>();
  for (const c of list) {
    if (c.kind === 'changed' || c.emailed_at) continue;
    bySlot.set(slot(c), [...(bySlot.get(slot(c)) ?? []), c]);
  }
  return list.filter((c) => {
    if (c.kind === 'changed' || c.emailed_at) return true;
    const same = bySlot.get(slot(c)) ?? [];
    const net = same.reduce((n, x) => n + (x.kind === 'added' ? 1 : -1), 0);
    return net !== 0 && same.every((x) => x.id <= c.id);
  });
}
