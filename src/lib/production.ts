/**
 * Production à partir des mercuriales : ce qu'il faut préparer et acheter pour chaque commande.
 *
 * Une commande nomme un plat. Si le plat est une fiche, on la prend telle quelle.
 * Sinon c'est un plat sur mesure, « Base + Protéine + Légume + Sauce » : chaque élément est une
 * fiche, multipliée par le facteur de son rôle (colonnes Facteur base, protéine… de PRESTATIONS).
 * Quantité nette = quantité de la fiche ÷ portions de la fiche × facteur × portions commandées.
 * Quantité à acheter = quantité nette × (1 + pertes de l'ingrédient), comme la feuille.
 */

export type Brand = 'saveurs_nomades' | 'comptoir';
export const BRANDS: Brand[] = ['saveurs_nomades', 'comptoir'];
export const BRAND_LABEL: Record<Brand, string> = { saveurs_nomades: 'Saveurs Nomades', comptoir: 'Comptoir Méditerranéen' };
export const ROLE_LABEL: Record<string, string> = { BASE: 'Base', PROTEINE: 'Protéine', LEGUME: 'Légume', SAUCE: 'Sauce' };

export interface MercSource { brand: Brand; label: string; sheet_url: string; file_name: string; synced_at: string | null; counts: Record<string, number | null> }
export interface MercRecipe { brand: Brand; name: string; category: string; portions: number; portion_weight: number | null; status: string; label: string; allergens: string; role: string }
export interface MercLine { id: number; brand: Brand; recipe: string; position: number; ingredient: string; quantity: number; unit: string; supplier: string; allergens: string; loss: number }
export interface MercOrder { id: number; brand: Brand; position: number; day: string; formula: string; dish: string; portions: number; check_status: string; factors: Record<string, number> }
export interface MercIngredient { name: string; category: string; supplier: string; purchase_unit: string; piece_weight: number | null; recipe_unit: string; allergens: string }
export interface MercPrice { name: string; purchase_price: number | null; recipe_unit_price: number | null }
export interface MercCost { brand: Brand; name: string; cost_portion: number | null; cost_portion_losses: number | null; sale_price: number | null; cost_pct: number | null }

/** Pour comparer des noms : sans accents, sans majuscules, espaces simples. */
export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Les fiches et leurs lignes, rangées pour les retrouver vite. */
export class Book {
  private recipes = new Map<string, MercRecipe>();
  private lines = new Map<string, MercLine[]>();
  constructor(recipes: MercRecipe[], lines: MercLine[]) {
    for (const r of recipes) this.recipes.set(`${r.brand}|${norm(r.name)}`, r);
    for (const l of [...lines].sort((a, b) => a.position - b.position)) {
      const k = `${l.brand}|${norm(l.recipe)}`;
      this.lines.set(k, [...(this.lines.get(k) ?? []), l]);
    }
  }
  recipe(brand: Brand, name: string) {
    return this.recipes.get(`${brand}|${norm(name)}`) ?? null;
  }
  linesOf(r: MercRecipe) {
    return this.lines.get(`${r.brand}|${norm(r.name)}`) ?? [];
  }
}

export interface Component { name: string; recipe: MercRecipe | null; role: string; factor: number }

/** Les fiches qui composent le plat d'une commande, avec leur facteur. */
export function components(o: MercOrder, book: Book): Component[] {
  const whole = book.recipe(o.brand, o.dish);
  if (whole) return [{ name: whole.name, recipe: whole, role: whole.role, factor: 1 }];
  return o.dish
    .split(/\s+\+\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const r = book.recipe(o.brand, p);
      const role = r?.role ?? '';
      const f = role && typeof o.factors?.[role] === 'number' ? o.factors[role] : 1;
      return { name: r?.name ?? p, recipe: r, role, factor: f };
    });
}

export interface Need { recipe: string; ingredient: string; unit: string; supplier: string; net: number; gross: number }

/** Ce qu'il faut pour une commande : une ligne par ingrédient de chaque fiche. */
export function orderNeeds(o: MercOrder, comps: Component[], book: Book): Need[] {
  const out: Need[] = [];
  for (const c of comps) {
    if (!c.recipe || c.factor <= 0) continue;
    for (const l of book.linesOf(c.recipe)) {
      const net = (l.quantity / c.recipe.portions) * c.factor * o.portions;
      out.push({ recipe: c.recipe.name, ingredient: l.ingredient, unit: l.unit, supplier: l.supplier, net, gross: net * (1 + (l.loss || 0)) });
    }
  }
  return out;
}

/** Problèmes à signaler pour une commande. */
export function orderIssues(comps: Component[], book: Book): string[] {
  const issues: string[] = [];
  for (const c of comps) {
    if (!c.recipe) issues.push(`Pas de fiche « ${c.name} »`);
    else if (book.linesOf(c.recipe).length === 0) issues.push(`Fiche vide « ${c.name} »`);
  }
  return issues;
}

export interface Purchase {
  supplier: string;
  ingredient: string;
  /** Quantité à acheter, dans l'unité d'achat de la mercuriale. */
  qty: number;
  unit: string;
  /** Même quantité, dans l'unité des fiches. */
  recipeQty: number;
  recipeUnit: string;
  price: number | null;
  cost: number | null;
}

const isPiece = (u: string) => /^pi[eè]ce/i.test(u.trim());

/** Convertit une quantité de recette (g ou pièce) dans l'unité d'achat (kg, L ou pièce). */
export function toPurchase(qty: number, unit: string, ing: MercIngredient | undefined): { qty: number; unit: string } {
  const pu = (ing?.purchase_unit ?? '').trim().toLowerCase();
  if (isPiece(unit)) return { qty, unit: 'pièce' };
  if (pu === 'kg') return { qty: qty / 1000, unit: 'kg' };
  if (pu === 'l') return { qty: qty / 1000, unit: 'L' };
  if (isPiece(pu) && ing?.piece_weight) return { qty: qty / ing.piece_weight, unit: 'pièce' };
  if (unit.trim().toLowerCase() === 'g') return { qty: qty / 1000, unit: 'kg' };
  return { qty, unit };
}

/** Liste de courses : les besoins additionnés par ingrédient, rangés par fournisseur. */
export function shopping(needs: Need[], ingredients: MercIngredient[], prices: MercPrice[] = []): Purchase[] {
  const ing = new Map(ingredients.map((i) => [norm(i.name), i]));
  const pr = new Map(prices.map((p) => [norm(p.name), p]));
  const sum = new Map<string, { ingredient: string; unit: string; supplier: string; qty: number }>();
  for (const n of needs) {
    const k = `${norm(n.ingredient)}|${isPiece(n.unit) ? 'pièce' : n.unit}`;
    const cur = sum.get(k);
    if (cur) cur.qty += n.gross;
    else sum.set(k, { ingredient: n.ingredient, unit: n.unit, supplier: n.supplier, qty: n.gross });
  }
  const out: Purchase[] = [];
  for (const s of sum.values()) {
    const i = ing.get(norm(s.ingredient));
    const p = pr.get(norm(s.ingredient));
    const buy = toPurchase(s.qty, s.unit, i);
    const qty = buy.unit === 'pièce' ? Math.ceil(buy.qty - 1e-9) : buy.qty;
    const price = p?.purchase_price ?? null;
    const cost = price != null ? buy.qty * price : p?.recipe_unit_price != null ? s.qty * p.recipe_unit_price : null;
    out.push({ supplier: i?.supplier || s.supplier || 'Sans fournisseur', ingredient: i?.name ?? s.ingredient, qty, unit: buy.unit, recipeQty: s.qty, recipeUnit: s.unit, price, cost });
  }
  return out.sort((a, b) => a.supplier.localeCompare(b.supplier, 'fr') || a.ingredient.localeCompare(b.ingredient, 'fr'));
}

const nf = (d: number) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Quantité lisible : grammes ou kilos, litres, pièces. */
export function fmtQty(qty: number, unit: string): string {
  const u = unit.trim();
  if (u.toLowerCase() === 'g') {
    if (qty >= 1000) return `${nf(2).format(qty / 1000)} kg`;
    return `${nf(qty < 10 ? 1 : 0).format(qty)} g`;
  }
  if (isPiece(u)) {
    const whole = Math.abs(qty - Math.round(qty)) < 0.05;
    const n = whole ? Math.round(qty) : qty;
    return `${nf(whole ? 0 : 1).format(n)} ${n > 1 ? 'pièces' : 'pièce'}`;
  }
  return `${nf(2).format(qty)} ${u}`;
}

export const fmtEuro = (n: number | null | undefined) => (n == null ? '–' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n));
export const fmtPct = (n: number | null | undefined) => (n == null ? '–' : `${nf(1).format(n * 100)} %`);
