import { describe, expect, it } from 'vitest';
import { Carte, allergensIn, fmtAmount, fmtUnitPrice, lineKey, plan, scaleFactor, toBase, verdict, type MenuItem, type MenuLine } from './carte';

/* Une petite carte inventée. */
const item = (p: Partial<MenuItem> & Pick<MenuItem, 'kind' | 'name'>): MenuItem => ({
  position: 1, category: '', status: 'OK', portions: 1, sale_price: null, vat: null, allergens: '',
  yield_qty: null, yield_unit: '', recipe_unit: '', used_in: '', ...p,
});
const line = (p: Partial<MenuLine> & Pick<MenuLine, 'kind' | 'recipe' | 'ingredient' | 'position'>): MenuLine => ({
  quantity: null, unit: 'g', loss: 0, gross: null, supplier: '', allergens: '', to_check: '', ...p,
});

const ITEMS = [
  item({ kind: 'plat', name: 'Burger test', position: 1, category: 'Plat', allergens: 'Gluten', sale_price: 16 }),
  item({ kind: 'plat', name: 'Salade test', position: 2, category: 'Entrée', allergens: 'Aucun déclaré', portions: 2 }),
  item({ kind: 'plat', name: 'Fiche vide test', position: 3, category: 'Plat', status: 'Fiche vide' }),
  item({ kind: 'boisson', name: 'Cocktail test', position: 4, category: 'Cocktail' }),
  item({ kind: 'preparation', name: 'Sauce test (maison)', position: 5, yield_qty: 1, yield_unit: 'kg', recipe_unit: 'g', allergens: 'Œufs, Moutarde' }),
  item({ kind: 'preparation', name: 'Frites test (maison)', position: 6, yield_qty: 10, yield_unit: 'pièce', recipe_unit: 'pièce' }),
];
const LINES = [
  line({ kind: 'plat', recipe: 'Burger test', position: 1, ingredient: 'Pain test', quantity: 1, unit: 'pièce', supplier: 'Boulanger', allergens: 'Gluten' }),
  line({ kind: 'plat', recipe: 'Burger test', position: 2, ingredient: 'Steak test', quantity: 150, unit: 'g', loss: 0.1, gross: 165, supplier: 'Boucher' }),
  line({ kind: 'plat', recipe: 'Burger test', position: 3, ingredient: 'Sauce test (maison)', quantity: 30, unit: 'g', supplier: 'Maison' }),
  line({ kind: 'plat', recipe: 'Burger test', position: 4, ingredient: 'Frites test (maison)', quantity: 1, unit: 'pièce', supplier: 'Maison' }),
  line({ kind: 'plat', recipe: 'Salade test', position: 5, ingredient: 'Salade', quantity: 100, unit: 'g', loss: 0.2, supplier: 'Primeur', to_check: 'Sulfites ?' }),
  line({ kind: 'plat', recipe: 'Salade test', position: 6, ingredient: 'Huile', quantity: null, unit: 'ml' }),
  line({ kind: 'boisson', recipe: 'Cocktail test', position: 7, ingredient: 'Rhum', quantity: 4, unit: 'cl', loss: 0.02, gross: 4.08, supplier: 'Cave' }),
  line({ kind: 'preparation', recipe: 'Sauce test (maison)', position: 8, ingredient: 'Jaune d\'œuf', quantity: 100, unit: 'g', supplier: 'Grossiste', allergens: 'Oeufs' }),
  line({ kind: 'preparation', recipe: 'Sauce test (maison)', position: 9, ingredient: 'Huile', quantity: 900, unit: 'ml', loss: 0.05, gross: 945, supplier: 'Grossiste' }),
  line({ kind: 'preparation', recipe: 'Frites test (maison)', position: 10, ingredient: 'Pommes de terre', quantity: 2000, unit: 'g', loss: 0.25, gross: 2500, supplier: 'Primeur' }),
];
const carte = new Carte(ITEMS, LINES);
/** Espaces insécables de la mise en forme française, en espaces simples. */
const sp = (t: string) => t.replace(/\s/g, ' ');

describe('carte Nuba', () => {
  it('reconnaît les allergènes écrits de plusieurs façons', () => {
    expect(allergensIn('Céleri, Lait')).toEqual(['céleri', 'lait']);
    expect(allergensIn('Oeufs; Fruits à coques / Poisson')).toEqual(['œufs', 'fruits à coque', 'poissons']);
    expect(allergensIn('Aucun déclaré')).toEqual([]);
    expect(allergensIn('Céréales contenant du gluten, Truffe')).toEqual(['gluten', 'truffe']);
    expect(allergensIn('Laitue')).toEqual(['laitue']);
  });

  it('additionne les allergènes de la fiche et de ses préparations maison', () => {
    const burger = carte.get('plat', 'burger TEST')!;
    expect(carte.allergens(burger)).toEqual(['gluten', 'œufs', 'moutarde']);
    expect(carte.usedIn(carte.get('preparation', 'Sauce test (maison)')!).map((i) => i.name)).toEqual(['Burger test']);
    expect(carte.categories('plat')).toEqual(['Plat', 'Entrée']);
  });

  it('dit ce que la salle peut proposer à un client allergique', () => {
    const v = (name: string, kind: 'plat' | 'boisson', ex: string[]) => verdict(carte, carte.get(kind, name)!, ex).v;
    expect(v('Burger test', 'plat', ['œufs'])).toBe('contains');
    expect(verdict(carte, carte.get('plat', 'Burger test')!, ['œufs', 'lait']).found).toEqual(['œufs']);
    expect(v('Salade test', 'plat', ['œufs'])).toBe('check');        // un ingrédient à vérifier
    expect(v('Fiche vide test', 'plat', ['œufs'])).toBe('check');    // fiche incomplète
    expect(v('Cocktail test', 'boisson', ['œufs'])).toBe('ok');
  });

  it('met une fiche à l\'échelle : portions, ou rendement pour une préparation', () => {
    expect(scaleFactor(carte.get('plat', 'Salade test')!, 10)).toBe(5);
    expect(scaleFactor(carte.get('preparation', 'Sauce test (maison)')!, 2.5)).toBe(2.5);
    expect(scaleFactor(ITEMS[0], 0)).toBe(0);
    expect(scaleFactor(item({ kind: 'preparation', name: 'x' }), 1)).toBeNull();
  });

  it('écrit les quantités simplement', () => {
    expect(fmtAmount(165, 'g')).toBe('165 g');
    expect(fmtAmount(2500, 'g')).toBe('2,5 kg');
    expect(fmtAmount(0.4, 'g')).toBe('0,4 g');
    expect(fmtAmount(4.08, 'cl')).toBe('4,1 cl');
    expect(fmtAmount(1890, 'ml')).toBe('1,89 L');
    expect(fmtAmount(40, 'ml')).toBe('40 ml');
    expect(fmtAmount(1, 'pièce')).toBe('1 pièce');
    expect(fmtAmount(2.5, 'pièces')).toBe('2,5 pièces');
    expect(toBase(2, 'L')).toEqual({ qty: 2000, unit: 'ml' });
    expect(sp(fmtUnitPrice(0.0015, 'g'))).toBe('1,50 € le kg');
    expect(sp(fmtUnitPrice(0.3, 'cl'))).toBe('30,00 € le litre');
    expect(sp(fmtUnitPrice(0.51, 'pièce'))).toBe('0,51 € la pièce');
    expect(toBase(3, 'botte')).toEqual({ qty: 3, unit: 'botte' });
  });

  it('calcule ce qu\'il faut pour 20 burgers et 2 cocktails, préparations maison décomposées', () => {
    const costs = new Map<string, number | null>([[lineKey(LINES[1]), 2.4], [lineKey(LINES[7]), 1.5], [lineKey(LINES[8]), 2.7], [lineKey(LINES[9]), 1.6], [lineKey(LINES[6]), 1.2]]);
    const p = plan(carte, [{ kind: 'plat', name: 'Burger test', qty: 20 }, { kind: 'boisson', name: 'Cocktail test', qty: 2 }], costs);
    expect(p.preps.map((x) => [x.item.name, x.qty, x.unit])).toEqual([['Sauce test (maison)', 600, 'g'], ['Frites test (maison)', 20, 'pièce']]);
    const raw = Object.fromEntries(p.raw.map((r) => [r.ingredient, [r.gross, r.unit, r.supplier]]));
    expect(raw['Pain test']).toEqual([20, 'pièce', 'Boulanger']);
    expect(raw['Steak test']).toEqual([3300, 'g', 'Boucher']);
    expect(raw["Jaune d'œuf"][0]).toBeCloseTo(60);             // 100 g pour 1 kg de sauce, 600 g de sauce
    expect(raw.Huile[0]).toBeCloseTo(567);                      // 945 ml × 0,6
    expect(raw['Pommes de terre'][0]).toBeCloseTo(5000);        // 2 500 g pour 10 portions, 20 portions
    expect(raw.Rhum[0]).toBeCloseTo(81.6);                      // 4,08 cl × 2, en ml
    expect(raw.Rhum.slice(1)).toEqual(['ml', 'Cave']);
    expect(p.raw.find((r) => r.ingredient === 'Rhum')!.prefer).toBe('cl');
    expect(p.raw.map((r) => r.supplier)).toEqual(['Boucher', 'Boulanger', 'Cave', 'Grossiste', 'Grossiste', 'Primeur']);
    // Coûts : steak 2,4 × 20 + sauce (1,5 + 2,7) × 0,6 + frites 1,6 × 2 + rhum 1,2 × 2 ; le pain n'a pas de prix.
    expect(p.cost).toBeCloseTo(48 + 2.52 + 3.2 + 2.4);
    expect(p.costMissing).toBe(1);
    expect(p.issues).toEqual([]);
  });

  it('signale ce qui manque dans la mercuriale', () => {
    const p = plan(carte, [{ kind: 'plat', name: 'Salade test', qty: 4 }, { kind: 'plat', name: 'Fiche vide test', qty: 1 }, { kind: 'plat', name: 'Disparue', qty: 1 }]);
    expect(p.issues).toEqual(['Quantité à saisir : « Salade test », Huile', 'Fiche sans ingrédient : « Fiche vide test »', 'Fiche introuvable : « Disparue »']);
    expect(p.raw.map((r) => [r.ingredient, r.gross])).toEqual([['Salade', 240]]);   // 100 g × 1,2 pour 2 portions, 4 portions
    expect(p.cost).toBe(0);
  });

  it('une préparation demandée seule compte aussi dans les préparations à faire', () => {
    const p = plan(carte, [{ kind: 'preparation', name: 'Sauce test (maison)', qty: 2 }]);
    expect(p.preps.map((x) => [x.item.name, x.qty, x.unit])).toEqual([['Sauce test (maison)', 2000, 'g']]);
    expect(p.raw.find((r) => r.ingredient === 'Huile')!.gross).toBeCloseTo(1890);
  });
});
