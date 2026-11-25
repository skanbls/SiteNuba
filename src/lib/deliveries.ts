/**
 * Réception des livraisons (migration 0029) : la photo du bon, sa lecture, les lignes reliées aux produits
 * de la mercuriale Nuba, et les écarts montrés pendant la vérification. La base refait les contrôles à la
 * validation ; ici, c'est pour les voir tout de suite.
 */

export interface MercProduct { key: string; name: string; category: string; supplier: string; unit: string; label: string }

export interface DeliveryLine {
  id?: string;
  label: string;
  product_id: string | null;
  merc_key: string | null;
  quantity: number | null;
  unit: string;
  unit_price: number | null;
  lot: string;
  use_by: string | null;
  ordered: number | null;
  skip: boolean;
  source: 'scan' | 'order' | 'manual';
  product_name?: string | null;
  product_unit?: string | null;
  merc_name?: string | null;
  merc_unit?: string | null;
}

export interface DeliveryIssue { kind: 'missing' | 'quantity' | 'price' | 'use_by' | 'total'; product: string; text: string }

export interface Delivery {
  id: string;
  supplier_id: string | null;
  supplier_name: string;
  order_id: string | null;
  status: 'draft' | 'done';
  bl_number: string;
  bl_date: string | null;
  bl_total_ht: number | null;
  scan_status: 'none' | 'pending' | 'done' | 'error';
  scan_at: string | null;
  scan_error: string;
  scan_note: string;
  ok: boolean | null;
  temp: number | null;
  note: string;
  issues: DeliveryIssue[];
  created_at: string;
  received_at: string | null;
  received_by_name?: string | null;
  pages: number;
  lines: DeliveryLine[];
}

/** Clé d'un nom de produit, comme _prod_key() dans la base : minuscules, sans accents, lettres et chiffres. */
export function prodKey(t: string): string {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Le nom à afficher pour le produit d'une ligne, et son unité. */
export const lineName = (l: DeliveryLine) => l.product_name ?? l.merc_name ?? '';
export const lineUnit = (l: DeliveryLine) => l.product_unit || l.merc_unit || l.unit || '';

/**
 * Ce qu'il faut regarder sur une ligne, avant de valider. `refPrice` : le prix connu du produit (s'il est lisible) ;
 * `withOrder` : la livraison répond à une commande de l'appli (sinon, « pas dans la commande » ne veut rien dire).
 */
export function lineFlags(l: DeliveryLine, today: string, refPrice?: number | null, withOrder = true): { tone: 'bad' | 'warn' | 'info'; text: string }[] {
  const out: { tone: 'bad' | 'warn' | 'info'; text: string }[] = [];
  const q = l.quantity ?? 0;
  if (l.skip) return [{ tone: 'info', text: 'Pas suivi en stock' }];
  if (!l.product_id && !l.merc_key && q > 0) out.push({ tone: 'bad', text: 'Produit à choisir' });
  if (l.ordered !== null && q === 0) out.push({ tone: 'bad', text: `Commandé ${fmtQty(l.ordered)}, pas livré` });
  else if (l.ordered !== null && Math.abs(q - l.ordered) > Math.max(0.01, l.ordered * 0.02)) out.push({ tone: 'warn', text: `Commandé ${fmtQty(l.ordered)}` });
  else if (withOrder && l.ordered === null && l.source !== 'order' && q > 0) out.push({ tone: 'info', text: 'Pas dans la commande' });
  if (refPrice && l.unit_price !== null && q > 0 && Math.abs(l.unit_price - refPrice) / refPrice > 0.05) {
    const pct = Math.round((Math.abs(l.unit_price - refPrice) / refPrice) * 100);
    out.push({ tone: 'warn', text: l.unit_price > refPrice ? `Prix +${pct} %` : `Prix −${pct} %` });
  }
  if (l.use_by && q > 0 && l.use_by < addDays(today, 2)) out.push({ tone: 'warn', text: `DLC ${l.use_by.split('-').reverse().join('/')}` });
  return out;
}

/** Total HT des lignes, pour le comparer au total du bon. */
export const linesTotal = (lines: DeliveryLine[]) => Math.round(lines.reduce((t, l) => t + (l.quantity ?? 0) * (l.unit_price ?? 0), 0) * 100) / 100;

export const fmtQty = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
const addDays = (iso: string, n: number) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** Recherche dans une liste de produits : chaque mot doit se retrouver (sans accents ni majuscules). */
export function searchProducts<T extends { name: string; label?: string; category?: string }>(list: T[], q: string, max = 40): T[] {
  const words = prodKey(q).split(' ').filter(Boolean);
  if (!words.length) return list.slice(0, max);
  return list.filter((p) => { const k = prodKey(`${p.name} ${p.label ?? ''} ${p.category ?? ''}`); return words.every((w) => k.includes(w)); }).slice(0, max);
}
