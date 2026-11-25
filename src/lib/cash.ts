/**
 * Fermeture de caisse (migration 0026) : les coupures, les écarts et les chiffres du tableau de bord.
 * La base refait les mêmes calculs à l'enregistrement : ici, c'est pour les montrer pendant la saisie.
 */

/** Billets et pièces, en centimes, du plus grand au plus petit. */
export const DENOMINATIONS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];
export const denomLabel = (c: number) => (c >= 100 ? `${c / 100} €` : `${c} c`);
export const isBill = (c: number) => c >= 500;

export interface CashClosing {
  id: string;
  day: string;
  status: 'draft' | 'closed';
  z_number: string;
  z_total: number | null;
  z_covers: number | null;
  z_tickets: number | null;
  z_cash: number | null;
  z_card: number | null;
  z_meal: number | null;
  z_cheque: number | null;
  z_other: number | null;
  float_start: number | null;
  cash_counts: Record<string, number>;
  cash_counted: number | null;
  expenses: { label: string; amount: number }[];
  expenses_total: number;
  float_end: number | null;
  card_counted: number | null;
  meal_counted: number | null;
  cheque_counted: number | null;
  tips: number | null;
  cash_expected: number | null;
  cash_gap: number | null;
  card_gap: number | null;
  meal_gap: number | null;
  cheque_gap: number | null;
  bank_deposit: number | null;
  note: string;
  has_photo: boolean;
  closed_by: string | null;
  closed_at: string | null;
  updated_at: string;
}

/** « 12,5 » ou « 12.50 » → 12.5 ; vide ou illisible → null. */
export function num(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\s/g, '').replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Total des espèces comptées, ou null si rien n'est compté. */
export function cashTotal(counts: Record<string, string | number>): number | null {
  let any = false, cents = 0;
  for (const c of DENOMINATIONS) {
    const n = num(counts[String(c)] ?? '');
    if (n === null) continue;
    any = true;
    cents += c * Math.max(0, Math.floor(n));
  }
  return any ? cents / 100 : null;
}

export interface CashCalc { counted: number | null; expenses: number; expected: number | null; cashGap: number | null; cardGap: number | null; mealGap: number | null; chequeGap: number | null; deposit: number | null }

/** Les mêmes calculs que la base : espèces attendues, écarts, remise en banque. */
export function calc(f: { counts: Record<string, string | number>; expenses: { amount: string | number }[]; float_start: string; float_end: string; z_cash: string; z_card: string; z_meal: string; z_cheque: string; card_counted: string; meal_counted: string; cheque_counted: string }): CashCalc {
  const counted = cashTotal(f.counts);
  const expenses = round2(f.expenses.reduce((t, e) => t + Math.max(0, num(e.amount) ?? 0), 0));
  const fs = num(f.float_start), zc = num(f.z_cash);
  const expected = fs !== null && zc !== null ? round2(fs + zc - expenses) : null;
  const gap = (a: number | null, b: number | null) => (a !== null && b !== null ? round2(a - b) : null);
  const fe = num(f.float_end);
  return {
    counted, expenses, expected,
    cashGap: gap(counted, expected),
    cardGap: gap(num(f.card_counted), num(f.z_card)),
    mealGap: gap(num(f.meal_counted), num(f.z_meal)),
    chequeGap: gap(num(f.cheque_counted), num(f.z_cheque)),
    deposit: counted !== null && fe !== null ? Math.max(0, round2(counted - fe)) : null,
  };
}

/** Le plus grand écart (en valeur absolue) : au-delà de 2 €, une explication est demandée. */
export const maxGap = (c: Pick<CashCalc, 'cashGap' | 'cardGap' | 'mealGap' | 'chequeGap'>) =>
  Math.max(...[c.cashGap, c.cardGap, c.mealGap, c.chequeGap].map((x) => Math.abs(x ?? 0)));
export const GAP_LIMIT = 2;

const addDays = (iso: string, n: number) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export interface CashStats {
  last: CashClosing | null;
  week: { ca: number; covers: number; days: number; previous: number };
  month: { ca: number; covers: number; days: number; previousSamePeriod: number; card: number; cash: number; meal: number; other: number; gaps: number };
  series: { labels: string[]; ca: (number | null)[] };
}

/** Les chiffres du tableau de bord à partir des fermetures clôturées. today : le jour de service (AAAA-MM-JJ). */
export function cashStats(closings: CashClosing[], today: string): CashStats {
  const closed = closings.filter((c) => c.status === 'closed' && c.z_total !== null).sort((a, b) => a.day.localeCompare(b.day));
  const sum = (xs: CashClosing[], f: (c: CashClosing) => number | null) => round2(xs.reduce((t, c) => t + (f(c) ?? 0), 0));
  const between = (from: string, to: string) => closed.filter((c) => c.day >= from && c.day <= to);
  // Les 7 derniers jours, aujourd'hui compris (la caisse se ferme le soir même), et les 7 d'avant.
  const w = between(addDays(today, -6), today);
  const wPrev = between(addDays(today, -13), addDays(today, -7));
  const monthStart = `${today.slice(0, 7)}-01`;
  const m = between(monthStart, today);
  const pm = new Date(`${monthStart}T12:00:00Z`);
  pm.setUTCMonth(pm.getUTCMonth() - 1);
  const pmStart = pm.toISOString().slice(0, 10);
  const pmSameDay = addDays(pmStart, Number(today.slice(8, 10)) - 1);
  const mPrev = between(pmStart, pmSameDay < monthStart ? pmSameDay : addDays(monthStart, -1));
  const labels: string[] = [], ca: (number | null)[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(today, -i);
    const c = closed.find((x) => x.day === d);
    labels.push(`${d.slice(8, 10)}/${d.slice(5, 7)}`);
    ca.push(c ? c.z_total : null);
  }
  return {
    last: closed[closed.length - 1] ?? null,
    week: { ca: sum(w, (c) => c.z_total), covers: sum(w, (c) => c.z_covers), days: w.length, previous: sum(wPrev, (c) => c.z_total) },
    month: {
      ca: sum(m, (c) => c.z_total), covers: sum(m, (c) => c.z_covers), days: m.length, previousSamePeriod: sum(mPrev, (c) => c.z_total),
      card: sum(m, (c) => c.z_card), cash: sum(m, (c) => c.z_cash), meal: sum(m, (c) => c.z_meal), other: sum(m, (c) => (c.z_cheque ?? 0) + (c.z_other ?? 0)),
      gaps: sum(m, (c) => c.cash_gap),
    },
    series: { labels, ca },
  };
}

/** Le fichier CSV d'un mois de fermetures (point-virgule, virgule décimale : il s'ouvre tel quel dans Excel). */
export function closingsCsv(closings: CashClosing[], names: Map<string, string>): string {
  const f = (n: number | null) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
  const head = ['Jour', 'N° de Z', 'CA TTC', 'Couverts', 'Tickets', 'Espèces (Z)', 'CB (Z)', 'Titres-restaurant (Z)', 'Chèques (Z)', 'Autres (Z)',
    'Fond de départ', 'Espèces comptées', 'Dépenses', 'Fond laissé', 'Remise en banque', 'CB (terminal)', 'Écart espèces', 'Écart CB', 'Écart titres', 'Écart chèques', 'Pourboires', 'Fermée par', 'Note'];
  const rows = [...closings].sort((a, b) => a.day.localeCompare(b.day)).map((c) => [
    c.day, c.z_number, f(c.z_total), f(c.z_covers), f(c.z_tickets), f(c.z_cash), f(c.z_card), f(c.z_meal), f(c.z_cheque), f(c.z_other),
    f(c.float_start), f(c.cash_counted), f(c.expenses_total), f(c.float_end), f(c.bank_deposit), f(c.card_counted), f(c.cash_gap), f(c.card_gap),
    f(c.meal_gap), f(c.cheque_gap), f(c.tips), names.get(c.closed_by ?? '') ?? '', c.note.replace(/\s*[\r\n;]+\s*/g, ' '),
  ]);
  return [head, ...rows].map((r) => r.map((x) => (/[;"]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x)).join(';')).join('\r\n');
}
