import { describe, expect, it } from 'vitest';
import { Book, components, familyOf, familyRank, fmtQty, orderIssues, orderNeeds, shopping, toPurchase, type MercIngredient, type MercLine, type MercOrder, type MercRecipe } from './production';

const R = (name: string, role = '', portions = 1, brand: 'saveurs_nomades' | 'comptoir' = 'saveurs_nomades'): MercRecipe =>
  ({ brand, name, category: '', portions, portion_weight: null, status: 'OK', label: '', allergens: '', role });
let id = 0;
const L = (recipe: string, ingredient: string, quantity: number, unit = 'g', loss = 0.05, supplier = 'Metro', brand: 'saveurs_nomades' | 'comptoir' = 'saveurs_nomades'): MercLine =>
  ({ id: ++id, brand, recipe, position: id, ingredient, quantity, unit, supplier, allergens: '', loss });
const O = (dish: string, portions: number, factors: Record<string, number> = {}, brand: 'saveurs_nomades' | 'comptoir' = 'saveurs_nomades'): MercOrder =>
  ({ id: ++id, brand, position: 1, day: '2026-11-18', formula: '', dish, portions, check_status: 'OK', factors });
const I = (name: string, purchase_unit: string, supplier = 'Metro', piece_weight: number | null = null): MercIngredient =>
  ({ name, category: '', supplier, purchase_unit, piece_weight, recipe_unit: 'g', allergens: '' });

const book = new Book(
  [R('Purée de patate douce', 'BASE'), R('Poulet Moutarde Miel (Mariné)', 'PROTEINE'), R('Haricots verts ail', 'LEGUME'), R('Brownie', '', 10), R('Brownie', '', 1, 'comptoir'), R('Fiche vide', 'SAUCE')],
  [
    L('Purée de patate douce', 'Patate douce', 200, 'g', 0.25, 'Primeur'),
    L('Purée de patate douce', 'Beurre', 10),
    L('Poulet Moutarde Miel (Mariné)', 'Cuisse de poulet s/os', 100, 'g', 0.05, 'Boucherie'),
    L('Haricots verts ail', 'Haricots verts', 120),
    L('Haricots verts ail', 'Beurre', 5),
    L('Brownie', 'Oeufs', 5, 'pièce'),
    L('Brownie', 'Beurre', 200),
    L('Brownie', 'Persil', 30),
    L('Brownie', 'Beurre', 50, 'g', 0.05, 'Metro', 'comptoir'),
  ],
);

describe('production des commandes', () => {
  it("un plat qui est une fiche se prend tel quel, sans tenir compte de l'écriture", () => {
    const c = components(O('brownie', 80), book);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ name: 'Brownie', factor: 1 });
    expect(c[0].recipe?.portions).toBe(10);
  });

  it('un plat sur mesure se découpe en fiches, chacune avec le facteur de son rôle', () => {
    const c = components(O('Purée de patate douce + Poulet Moutarde Miel (Mariné) + Haricots verts ail', 120, { BASE: 0.85, PROTEINE: 0.7, LEGUME: 0.9, SAUCE: 0 }), book);
    expect(c.map((x) => [x.name, x.role, x.factor])).toEqual([
      ['Purée de patate douce', 'BASE', 0.85],
      ['Poulet Moutarde Miel (Mariné)', 'PROTEINE', 0.7],
      ['Haricots verts ail', 'LEGUME', 0.9],
    ]);
  });

  it('quantité nette = fiche ÷ portions de la fiche × facteur × portions ; à acheter, avec les pertes', () => {
    const o = O('Purée de patate douce + Poulet Moutarde Miel (Mariné)', 120, { BASE: 0.85, PROTEINE: 0.7 });
    const n = orderNeeds(o, components(o, book), book);
    const pd = n.find((x) => x.ingredient === 'Patate douce')!;
    expect(pd.net).toBeCloseTo(200 * 0.85 * 120);
    expect(pd.gross).toBeCloseTo(200 * 0.85 * 120 * 1.25);
    expect(n.find((x) => x.ingredient === 'Cuisse de poulet s/os')!.gross).toBeCloseTo(100 * 0.7 * 120 * 1.05);
    const b = orderNeeds(O('Brownie', 80), components(O('Brownie', 80), book), book);
    expect(b.find((x) => x.ingredient === 'Oeufs')!.net).toBeCloseTo(40);   // 5 œufs pour 10 portions
  });

  it("chaque mercuriale garde ses fiches : le Brownie du Comptoir n'est pas celui de Saveurs Nomades", () => {
    const o = O('Brownie', 20, {}, 'comptoir');
    const n = orderNeeds(o, components(o, book), book);
    expect(n).toHaveLength(1);
    expect(n[0].net).toBeCloseTo(1000);
  });

  it('signale une fiche absente ou vide', () => {
    const c = components(O('Purée de patate douce + Poulet inconnu + Fiche vide', 10, { BASE: 1 }), book);
    expect(orderIssues(c, book)).toEqual(['Pas de fiche « Poulet inconnu »', 'Fiche vide « Fiche vide »']);
  });

  it("convertit dans l'unité d'achat", () => {
    expect(toPurchase(1500, 'g', I('Beurre', 'kg'))).toEqual({ qty: 1.5, unit: 'kg' });
    expect(toPurchase(945, 'g', I('Crème liquide', 'L'))).toEqual({ qty: 0.945, unit: 'L' });
    expect(toPurchase(120, 'g', I('Persil', 'pièce', 'Metro', 50))).toEqual({ qty: 2.4, unit: 'pièce' });
    expect(toPurchase(39, 'pièce', I('Oeufs', 'pièce'))).toEqual({ qty: 39, unit: 'pièce' });
    expect(toPurchase(2500, 'g', undefined)).toEqual({ qty: 2.5, unit: 'kg' });
  });

  it('additionne les besoins de plusieurs commandes, par fournisseur, avec le coût estimé', () => {
    const o1 = O('Purée de patate douce + Haricots verts ail', 100, { BASE: 1, LEGUME: 1 });
    const o2 = O('Brownie', 80);
    const needs = [...orderNeeds(o1, components(o1, book), book), ...orderNeeds(o2, components(o2, book), book)];
    const list = shopping(needs, [I('Beurre', 'kg'), I('Patate douce', 'kg', 'Primeur'), I('Oeufs', 'pièce'), I('Persil', 'pièce', 'Metro', 50), I('Haricots verts', 'kg')],
      [{ name: 'Beurre', purchase_price: 6.4, recipe_unit_price: 0.0064 }, { name: 'Oeufs', purchase_price: null, recipe_unit_price: 0.25 }]);
    expect(list.map((p) => [p.supplier, p.ingredient, p.unit])).toEqual([
      ['Metro', 'Beurre', 'kg'], ['Metro', 'Haricots verts', 'kg'], ['Metro', 'Oeufs', 'pièce'], ['Metro', 'Persil', 'pièce'], ['Primeur', 'Patate douce', 'kg'],
    ]);
    const beurre = list.find((p) => p.ingredient === 'Beurre')!;
    // 10 g × 100 (purée) + 5 g × 100 (haricots) + 200 g ÷ 10 × 80 (brownie), plus 5 % de pertes
    expect(beurre.recipeQty).toBeCloseTo((1000 + 500 + 1600) * 1.05);
    expect(beurre.qty).toBeCloseTo(3.255);
    expect(beurre.cost).toBeCloseTo(3.255 * 6.4);
    expect(list.find((p) => p.ingredient === 'Oeufs')).toMatchObject({ qty: 42, cost: 42 * 0.25 });   // 40 × 1,05, arrondi à la pièce
    expect(list.find((p) => p.ingredient === 'Persil')!.qty).toBe(6);   // 252 g en bottes de 50 g
    expect(list.find((p) => p.ingredient === 'Haricots verts')!.cost).toBeNull();
  });

  it('écrit les quantités simplement', () => {
    expect(fmtQty(12345, 'g')).toBe('12,35 kg');
    expect(fmtQty(232.4, 'g')).toBe('232 g');
    expect(fmtQty(0.3, 'g')).toBe('0,3 g');
    expect(fmtQty(39, 'pièce')).toBe('39 pièces');
    expect(fmtQty(1, 'pièce')).toBe('1 pièce');
    expect(fmtQty(0.25, 'pièce')).toBe('0,3 pièce');
    expect(fmtQty(0.945, 'L')).toBe('0,95 L');
  });

  it('range les ingrédients par famille, comme la mercuriale', () => {
    expect(['FRUITS / LEGUMES', 'CREMERIE', 'VIANDES / POISSONS', 'EPICERIE', 'SIROPS / JUS', 'CAFE / THE', 'BIERES', 'VINS', 'SPIRITUEUX', 'BOISSONS', 'EMBALLAGES', '', 'Vaisselle jetable', 'Produits d\'entretien'].map(familyOf))
      .toEqual(['Fruits et légumes', 'Crèmerie', 'Viandes et poissons', 'Épicerie', 'Sirops et jus', 'Café et thé', 'Bières', 'Vins', 'Spiritueux', 'Boissons', 'Emballages', 'Sans famille', 'Emballages', "Produits d'entretien"]);
    expect(['Fruits et légumes', 'Crèmerie', "Produits d'entretien", 'Sans famille'].map(familyRank)).toEqual([0, 2, 50, 99]);
  });
});
