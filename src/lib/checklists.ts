/**
 * Checklists selon le planning (migration 0025) : chaque liste a un poste, et les listes de la semaine
 * ou du mois peuvent avoir leur jour. Ici, ce que l'écran en montre ; la base calcule les dates.
 */
import type { Checklist } from './types';

/** Les postes du planning, proposés pour une liste. */
export const POSTES = ['Salle', 'Bar', 'Cuisine'];

const DAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const RANKS = ['', '1er', '2e', '3e', '4e', 'dernier'];

/** « le mardi », « le 1er mardi du mois », « le dernier lundi du mois », ou '' sans jour prévu. */
export function dueLabel(c: Pick<Checklist, 'frequency' | 'due_weekday' | 'due_week'>): string {
  const d = c.due_weekday ? DAYS[c.due_weekday - 1] : '';
  if (!d) return '';
  if (c.frequency === 'weekly') return `le ${d}`;
  if (c.frequency === 'monthly' && c.due_week) return `le ${RANKS[c.due_week]} ${d} du mois`;
  return '';
}

/** « Chaque semaine, le mardi · Salle » : quand et pour qui. */
export function whenLabel(c: Checklist): string {
  const when = c.frequency === 'daily' ? 'Chaque jour' : c.frequency === 'weekly' ? 'Chaque semaine' : 'Chaque mois';
  const due = dueLabel(c);
  const who = c.area ? c.area : "toute l'équipe au planning";
  return `${when}${due ? `, ${due}` : ''} · ${who}`;
}

export const complete = (c: Checklist) => c.items.length > 0 && c.items.every((i) => i.done);

/** Pas faite alors que son jour est passé, dans la période en cours. */
export const isLate = (c: Checklist, today: string) => !!c.due && c.due < today && !complete(c);

/**
 * À faire aujourd'hui par la personne : une liste de son poste du jour, du jour même, ou de la semaine
 * ou du mois quand c'est son jour (ou en retard), ou sans jour prévu tant qu'elle n'est pas finie.
 */
export function forMeToday(c: Checklist, today: string): boolean {
  if (!c.mine) return false;
  if (c.frequency === 'daily') return true;
  if (!c.due_weekday) return !complete(c);
  return c.next_due === today || isLate(c, today);
}

/** Prévue demain pour la personne (elle est au planning demain, à ce poste) : c'est le rappel de la veille. */
export function forMeTomorrow(c: Checklist, tomorrow: string): boolean {
  return !!c.mine_tomorrow && c.frequency !== 'daily' && !!c.due_weekday && c.next_due === tomorrow;
}
