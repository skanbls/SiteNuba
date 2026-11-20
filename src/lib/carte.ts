/**
 * La carte Nuba, reçue de la mercuriale Nuba : fiches cuisine, fiches bar et préparations maison.
 *
 * Une ligne de fiche donne la quantité nette pour toute la fiche (ses portions), ses pertes
 * et la quantité brute à sortir. Une ligne peut nommer une préparation maison
 * (« Mayonnaise (maison) ») : on la retrouve par son nom, et on descend dans sa fiche
 * selon son rendement (1 kg de mayonnaise, 10 portions de frites…).
 */
import { norm } from './production';
import { ALLERGENS } from './types';

export type MenuKind = 'plat' | 'boisson' | 'preparation';
export const KIND_LABEL: Record<MenuKind, string> = { plat: 'Cuisine', boisson: 'Bar', preparation: 'Préparation maison' };

export interface MenuItem {
  kind: MenuKind; name: string; position: number; category: string; status: string; portions: number;
  sale_price: number | null; vat: number | null; allergens: string;
  yield_qty: number | null; yield_unit: string; recipe_unit: string; used_in: string;
}
export interface MenuCost {
  kind: MenuKind; name: string; cost_portion: number | null; sale_price_ht: number | null; margin: number | null;
  cost_pct: number | null; target_pct: number | null; coefficient: number | null; suggested_price: number | null;
  cost_total: number | null; cost_unit: number | null; cost_recipe_unit: number | null;
}
export interface MenuLine {
  kind: MenuKind; recipe: string; position: number; ingredient: string; quantity: number | null; unit: string;
  loss: number; gross: number | null; supplier: string; allergens: string; to_check: string;
}
export interface MenuLineCost { kind: MenuKind; recipe: string; position: number; unit_price: number | null; cost: number | null }

const itemKey = (kind: string, name: string) => `${kind}|${norm(name)}`;
export const lineKey = (l: { kind: string; recipe: string; position: number }) => `${l.kind}|${l.recipe}|${l.position}`;

/** La fiche est complète (la mercuriale écrit « OK »). */
export const isComplete = (i: MenuItem) => norm(i.status) === 'ok';
/** Ces états rendent la liste d'allergènes incertaine : il manque des ingrédients. */
export const allergensUncertain = (i: MenuItem) => ['fiche vide', 'ingredient inconnu'].includes(norm(i.status));

/* ---------- Allergènes ---------- */
const akey = (t: string) => norm(t).replace(/œ/g, 'oe').replace(/s\b/g, '');
const STEMS = ALLERGENS.map((a) => ({ a, re: new RegExp(`\\b${akey(a)}\\b`) }));

/** Allergènes d'un texte (« Gluten, Œufs »), écrits comme la liste officielle quand on les reconnaît. */
export function allergensIn(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,;/|]/)) {
    const t = raw.trim();
    if (!t || /^aucun/i.test(t)) continue;
    const k = akey(t);
    const found = STEMS.filter((s) => s.re.test(k)).map((s) => s.a);
    for (const a of found.length ? found : [t.toLowerCase()]) if (!out.includes(a)) out.push(a);
  }
  return out;
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- Unités ---------- */
const UNITS: Record<string, [string, number]> = {
  g: ['g', 1], gr: ['g', 1], gramme: ['g', 1], kg: ['g', 1000], kilo: ['g', 1000], mg: ['g', 0.001],
  ml: ['ml', 1], cl: ['ml', 10], dl: ['ml', 100], l: ['ml', 1000], litre: ['ml', 1000],
  piece: ['pièce', 1], pc: ['pièce', 1], u: ['pièce', 1], unite: ['pièce', 1], portion: ['pièce', 1],
};

/** Quantité ramenée en grammes, millilitres ou pièces. Une unité inconnue reste telle quelle. */
export function toBase(qty: number, unit: string): { qty: number; unit: string } {
  const u = norm(unit).replace(/s$/, '');
  const m = UNITS[u];
  return m ? { qty: qty * m[1], unit: m[0] } : { qty, unit: unit.trim() };
}

const nf = (min: number, max: number) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: min, maximumFractionDigits: max });
const smart = (v: number) => (Math.abs(v) < 1 ? nf(0, 2) : Math.abs(v) < 10 ? nf(0, 1) : nf(0, 0)).format(v);

/** Quantité lisible : g ou kg, cl ou ml ou L, pièces. `prefer` garde les cl du bar. */
export function fmtAmount(qty: number, unit: string, prefer = unit): string {
  const b = toBase(qty, unit);
  if (b.unit === 'g') return b.qty >= 1000 ? `${nf(0, 2).format(b.qty / 1000)} kg` : `${smart(b.qty)} g`;
  if (b.unit === 'ml') {
    if (b.qty >= 1000) return `${nf(0, 2).format(b.qty / 1000)} L`;
    return norm(prefer) === 'cl' ? `${smart(b.qty / 10)} cl` : `${smart(b.qty)} ml`;
  }
  if (b.unit === 'pièce') {
    const whole = Math.abs(b.qty - Math.round(b.qty)) < 0.05;
    const n = whole ? Math.round(b.qty) : b.qty;
    return `${whole ? nf(0, 0).format(n) : nf(1, 1).format(n)} ${n > 1 ? 'pièces' : 'pièce'}`;
  }
  return `${smart(b.qty)} ${b.unit}`.trim();
}

/** Prix d'achat lisible : au kilo, au litre ou à la pièce plutôt qu'au gramme. */
export function fmtUnitPrice(price: number, unit: string): string {
  const b = toBase(1, unit);
  const eur = (v: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(v);
  if (b.unit === 'g') return `${eur((price / b.qty) * 1000)} le kg`;
  if (b.unit === 'ml') return `${eur((price / b.qty) * 1000)} le litre`;
  if (b.unit === 'pièce') return `${eur(price)} la pièce`;
  return `${nf(2, 4).format(price)} € le ${unit || 'unité'}`;
}

/** Quantité brute d'une ligne : celle de la feuille, sinon nette + pertes. */
export const grossOf = (l: MenuLine) => l.gross ?? (l.quantity != null ? l.quantity * (1 + (l.loss || 0)) : null);

/* ---------- La carte rangée ---------- */
export class Carte {
  readonly items: MenuItem[];
  private byKey = new Map<string, MenuItem>();
  private preps = new Map<string, MenuItem>();
  private lines = new Map<string, MenuLine[]>();

  constructor(items: MenuItem[], lines: MenuLine[]) {
    this.items = [...items].sort((a, b) => a.position - b.position);
    for (const i of this.items) {
      this.byKey.set(itemKey(i.kind, i.name), i);
      if (i.kind === 'preparation') this.preps.set(norm(i.name), i);
    }
    for (const l of [...lines].sort((a, b) => a.position - b.position)) {
      const k = itemKey(l.kind, l.recipe);
      this.lines.set(k, [...(this.lines.get(k) ?? []), l]);
    }
  }

  get(kind: MenuKind, name: string) {
    return this.byKey.get(itemKey(kind, name)) ?? null;
  }
  of(kind: MenuKind) {
    return this.items.filter((i) => i.kind === kind);
  }
  linesOf(i: MenuItem) {
    return this.lines.get(itemKey(i.kind, i.name)) ?? [];
  }
  /** La préparation maison nommée par une ligne, s'il y en a une. */
  prepOf(l: MenuLine): MenuItem | null {
    const p = this.preps.get(norm(l.ingredient));
    return p && !(l.kind === 'preparation' && norm(l.recipe) === norm(p.name)) ? p : null;
  }
  /** Les fiches qui utilisent une préparation. */
  usedIn(prep: MenuItem): MenuItem[] {
    return this.items.filter((i) => i !== prep && this.linesOf(i).some((l) => this.prepOf(l) === prep));
  }
  /** Catégories d'un service, dans l'ordre de la mercuriale. */
  categories(kind: MenuKind): string[] {
    return Array.from(new Set(this.of(kind).map((i) => i.category || 'Sans catégorie')));
  }
  /** Tous les allergènes d'une fiche, préparations maison comprises. */
  allergens(i: MenuItem, depth = 0): string[] {
    const out = new Set(allergensIn(i.allergens));
    for (const l of this.linesOf(i)) {
      for (const a of allergensIn(l.allergens)) out.add(a);
      const p = depth < 5 ? this.prepOf(l) : null;
      if (p) for (const a of this.allergens(p, depth + 1)) out.add(a);
    }
    return ALLERGENS.filter((a) => out.has(a)).concat([...out].filter((a) => !ALLERGENS.includes(a)));
  }
  /** Ingrédients dont les allergènes sont à vérifier (préparations comprises). */
  toCheck(i: MenuItem, depth = 0): { ingredient: string; note: string }[] {
    const out: { ingredient: string; note: string }[] = [];
    for (const l of this.linesOf(i)) {
      if (l.to_check) out.push({ ingredient: l.ingredient, note: l.to_check });
      const p = depth < 5 ? this.prepOf(l) : null;
      if (p) out.push(...this.toCheck(p, depth + 1));
    }
    return out.filter((x, k) => out.findIndex((y) => y.ingredient === x.ingredient) === k);
  }
  /** Fiche dont les allergènes sont incertains : incomplète, ou une préparation l'est. */
  uncertain(i: MenuItem, depth = 0): boolean {
    if (allergensUncertain(i)) return true;
    return depth < 5 && this.linesOf(i).some((l) => {
      const p = this.prepOf(l);
      return p ? this.uncertain(p, depth + 1) : false;
    });
  }
}

/** Facteur pour une quantité voulue : portions (plat, boisson) ou unités du rendement (préparation). */
export function scaleFactor(i: MenuItem, wanted: number): number | null {
  if (i.kind === 'preparation') return i.yield_qty ? wanted / i.yield_qty : null;
  return wanted / (i.portions || 1);
}

/* ---------- Le client ne peut pas manger… ---------- */
export type Verdict = 'ok' | 'contains' | 'check';
export function verdict(carte: Carte, i: MenuItem, excluded: string[]): { v: Verdict; found: string[] } {
  const found = carte.allergens(i).filter((a) => excluded.includes(a));
  if (found.length) return { v: 'contains', found };
  if (carte.uncertain(i) || carte.toCheck(i).length) return { v: 'check', found };
  return { v: 'ok', found };
}

/* ---------- Quantités pour un service ou un événement ---------- */
export interface Want { kind: MenuKind; name: string; qty: number }
export interface PrepNeed { item: MenuItem; qty: number; unit: string }
export interface RawNeed { ingredient: string; supplier: string; unit: string; prefer: string; gross: number; net: number; cost: number | null }
export interface Plan { preps: PrepNeed[]; raw: RawNeed[]; issues: string[]; cost: number; costMissing: number }

/**
 * Ce qu'il faut pour les fiches choisies : les préparations maison à faire, puis les ingrédients
 * à sortir ou à commander (pertes comprises), préparations décomposées.
 * `lineCosts` (accès fiches) : coût de chaque ligne de fiche, pour estimer le coût matière.
 */
export function plan(carte: Carte, wants: Want[], lineCosts?: Map<string, number | null>): Plan {
  const preps = new Map<string, PrepNeed>();
  const raw = new Map<string, RawNeed>();
  const issues = new Set<string>();
  let cost = 0;
  let costMissing = 0;

  const addPrep = (p: MenuItem, qty: number, unit: string) => {
    const cur = preps.get(norm(p.name));
    if (!cur) preps.set(norm(p.name), { item: p, qty, unit });
    else if (cur.unit === unit) cur.qty += qty;
    else issues.add(`Unités à vérifier pour « ${p.name} » : ${cur.unit} et ${unit}`);
  };
  const lineCost = (l: MenuLine, factor: number) => {
    if (!lineCosts) return null;
    const c = lineCosts.get(lineKey(l));
    if (c == null) {
      costMissing++;
      return null;
    }
    cost += c * factor;
    return c * factor;
  };

  const add = (item: MenuItem, factor: number, depth: number) => {
    if (depth > 5) {
      issues.add(`Préparations imbriquées trop loin : « ${item.name} »`);
      return;
    }
    const lines = carte.linesOf(item);
    if (lines.length === 0) issues.add(`Fiche sans ingrédient : « ${item.name} »`);
    for (const l of lines) {
      const g = grossOf(l);
      if (g == null) {
        issues.add(`Quantité à saisir : « ${item.name} », ${l.ingredient}`);
        continue;
      }
      const qty = toBase(g * factor, l.unit);
      const p = carte.prepOf(l);
      if (p) {
        addPrep(p, qty.qty, qty.unit);
        const y = p.yield_qty ? toBase(p.yield_qty, p.yield_unit) : null;
        if (!y) {
          issues.add(`Rendement à saisir : « ${p.name} »`);
          lineCost(l, factor);
        } else if (y.unit !== qty.unit) {
          issues.add(`Unités à vérifier : « ${p.name} » est en ${l.unit} dans « ${item.name} », son rendement en ${p.yield_unit}`);
          lineCost(l, factor);
        } else add(p, qty.qty / y.qty, depth + 1);
        continue;
      }
      const net = toBase((l.quantity ?? g) * factor, l.unit);
      const c = lineCost(l, factor);
      const k = `${norm(l.ingredient)}|${qty.unit}`;
      const cur = raw.get(k);
      if (cur) {
        cur.gross += qty.qty;
        cur.net += net.qty;
        cur.cost = cur.cost != null && c != null ? cur.cost + c : null;
        if (!cur.supplier && l.supplier) cur.supplier = l.supplier;
      } else {
        raw.set(k, { ingredient: l.ingredient, supplier: l.supplier, unit: qty.unit, prefer: l.unit, gross: qty.qty, net: net.qty, cost: lineCosts ? c : null });
      }
    }
  };

  for (const w of wants) {
    const i = carte.get(w.kind, w.name);
    if (!i) {
      issues.add(`Fiche introuvable : « ${w.name} »`);
      continue;
    }
    if (!(w.qty > 0)) continue;
    const f = scaleFactor(i, w.qty);
    if (i.kind === 'preparation') {
      const q = toBase(w.qty, i.yield_unit || i.recipe_unit);
      addPrep(i, q.qty, q.unit);
    }
    if (f == null) {
      issues.add(`Rendement à saisir : « ${i.name} »`);
      continue;
    }
    add(i, f, 0);
  }

  return {
    preps: [...preps.values()].sort((a, b) => a.item.position - b.item.position),
    raw: [...raw.values()].sort((a, b) => (a.supplier || '~').localeCompare(b.supplier || '~', 'fr') || a.ingredient.localeCompare(b.ingredient, 'fr')),
    issues: [...issues],
    cost,
    costMissing,
  };
}
