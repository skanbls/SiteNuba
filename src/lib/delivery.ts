/**
 * Bons de livraison des commandes Saveurs Nomades et Comptoir Méditerranéen (client Mijote).
 * Même présentation que l'onglet « BL À IMPRIMER » de la mercuriale : une ligne par commande du jour,
 * avec la marque, le plat et son conditionnement, les allergènes de ses fiches, le lot, la DLC
 * et les quantités. L'en-tête (expéditeur, client, lieu) vient de la base : table delivery_settings.
 */
import { allergensIn, cap } from './carte';
import { BRAND_LABEL, components, type Book, type Brand, type MercOrder } from './production';
import { addDays, fromDayKey } from './time';

export interface DeliverySettings {
  sender_name: string; sender_tagline: string; sender_address: string; sender_siret: string; sender_contact: string;
  client_name: string; client_address: string; client_siret: string;
  place_name: string; place_address: string; place_access: string;
  slot: string; driver: string; dlc_days: number; lot_days_before: number; updated_at: string | null;
}
export const EMPTY_DELIVERY: DeliverySettings = {
  sender_name: '', sender_tagline: '', sender_address: '', sender_siret: '', sender_contact: '',
  client_name: '', client_address: '', client_siret: '', place_name: '', place_address: '', place_access: '',
  slot: '', driver: '', dlc_days: 3, lot_days_before: 1, updated_at: null,
};

/** Les deux marques ensemble, ou une seule. */
export type Scope = 'tout' | Brand;
const ORDER: Brand[] = ['saveurs_nomades', 'comptoir'];

export interface DeliveryLine {
  id: number;
  brand: Brand;
  brandLabel: string;
  /** Le plat ; un plat sur mesure s'écrit « Base / Protéine / Légume ». */
  name: string;
  /** Formule ou catégorie, et conditionnement. */
  detail: string;
  allergens: string[];
  qty: number;
  /** Éléments du plat sans fiche : leurs allergènes manquent. */
  missing: string[];
}

/** Soupes et veloutés partent en boîtes en carton, le reste en barquettes scellées. */
export const packaging = (text: string) => (/soupe|velout/i.test(text) ? 'Boîtes en carton' : 'Barquettes scellées');

const fr = (a: string, b: string) => a.localeCompare(b, 'fr', { sensitivity: 'base' });

export function deliveryLines(orders: MercOrder[], book: Book, day: string, scope: Scope): DeliveryLine[] {
  return orders
    .filter((o) => o.day === day && o.portions > 0 && (scope === 'tout' || o.brand === scope))
    .sort((a, b) => ORDER.indexOf(a.brand) - ORDER.indexOf(b.brand) || a.position - b.position)
    .map((o) => {
      const comps = components(o, book);
      const allergens = new Set<string>();
      for (const c of comps) if (c.recipe && c.factor > 0) for (const a of allergensIn(c.recipe.allergens)) allergens.add(cap(a));
      const cats = comps.map((c) => c.recipe?.category ?? '').join(' ');
      return {
        id: o.id,
        brand: o.brand,
        brandLabel: BRAND_LABEL[o.brand],
        name: o.dish.split(/\s+\+\s+/).map((p) => p.trim()).filter(Boolean).join(' / '),
        detail: [o.formula || comps[0]?.recipe?.category || '', packaging(`${o.formula} ${o.dish} ${cats}`)].filter(Boolean).join(' · '),
        allergens: [...allergens].sort(fr),
        qty: o.portions,
        missing: comps.filter((c) => !c.recipe).map((c) => c.name),
      };
    });
}

const pad = (n: number) => String(n).padStart(2, '0');
const ddmmyyyy = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

/** BL-2026-1118-01 pour les deux marques, -SN ou -CM pour une seule. */
export const blNumber = (day: string, scope: Scope) =>
  `BL-${day.slice(0, 4)}-${day.slice(5, 7)}${day.slice(8, 10)}-${scope === 'tout' ? '01' : scope === 'saveurs_nomades' ? 'SN' : 'CM'}`;

/** Numéro de lot : L + date de production (la veille par défaut), « L261117 ». */
export function lotOf(day: string, daysBefore: number): string {
  const d = addDays(fromDayKey(day), -daysBefore);
  return `L${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Date limite de consommation : livraison + n jours. */
export const dlcOf = (day: string, days: number) => ddmmyyyy(addDays(fromDayKey(day), days));
export const fmtDayFr = (day: string) => ddmmyyyy(fromDayKey(day));

/** Température saisie (« 2 », « +2,1 », « -18 ») écrite comme sur le bon : « +2,0 °C ». */
export function fmtTemp(t: string): string {
  const clean = t.replace(',', '.').replace(/[^0-9.+-]/g, '');
  const n = Number(clean);
  if (!/[0-9]/.test(clean) || Number.isNaN(n)) return '';
  return `${n > 0 ? '+' : ''}${n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C`;
}
