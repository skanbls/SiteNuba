import { describe, expect, it } from 'vitest';
import { blNumber, deliveryLines, dlcOf, fmtTemp, lotOf, packaging } from './delivery';
import { Book, type MercOrder, type MercRecipe } from './production';

/* Deux mercuriales réduites, inventées. */
const rec = (p: Partial<MercRecipe> & Pick<MercRecipe, 'brand' | 'name'>): MercRecipe => ({ category: '', portions: 1, portion_weight: null, status: 'OK', label: '', allergens: '', role: '', ...p });
const RECIPES = [
  rec({ brand: 'saveurs_nomades', name: 'Purée test', category: 'BASE', allergens: 'Lait', role: 'BASE' }),
  rec({ brand: 'saveurs_nomades', name: 'Poulet test', category: 'PROTEINE', allergens: 'Moutarde | Lait', role: 'PROTEINE' }),
  rec({ brand: 'saveurs_nomades', name: 'Légume test', category: 'LEGUME', allergens: 'Céleri', role: 'LEGUME' }),
  rec({ brand: 'saveurs_nomades', name: 'Brownie test', category: 'Dessert', allergens: 'Gluten, Œufs, Fruits à coque' }),
  rec({ brand: 'saveurs_nomades', name: 'Velouté test', category: 'Soupe', allergens: 'Aucun' }),
  rec({ brand: 'comptoir', name: 'Tarte test', category: 'Entrée', allergens: 'Gluten, Lait, Oeufs' }),
];
const order = (p: Partial<MercOrder> & Pick<MercOrder, 'id' | 'brand' | 'dish' | 'portions'>): MercOrder => ({ position: p.id, day: '2026-11-18', formula: '', check_status: 'OK', factors: {}, ...p });
const ORDERS = [
  order({ id: 3, brand: 'comptoir', dish: 'Tarte test', portions: 40, formula: 'Entrée' }),
  order({ id: 1, brand: 'saveurs_nomades', dish: 'Purée test + Poulet test + Légume test', portions: 120, formula: 'Sur mesure', factors: { BASE: 0.8, PROTEINE: 0.7, LEGUME: 0 } }),
  order({ id: 2, brand: 'saveurs_nomades', dish: 'Brownie test', portions: 80, formula: 'Dessert' }),
  order({ id: 4, brand: 'saveurs_nomades', dish: 'Velouté test', portions: 30 }),
  order({ id: 5, brand: 'saveurs_nomades', dish: 'Plat sans fiche', portions: 10, formula: 'Plat' }),
  order({ id: 6, brand: 'saveurs_nomades', dish: 'Brownie test', portions: 50, day: '2026-11-25' }),
];
const book = new Book(RECIPES, []);

describe('bons de livraison', () => {
  it('une ligne par commande du jour, Saveurs Nomades puis Comptoir', () => {
    const lines = deliveryLines(ORDERS, book, '2026-11-18', 'tout');
    expect(lines.map((l) => [l.brandLabel, l.name, l.qty])).toEqual([
      ['Saveurs Nomades', 'Purée test / Poulet test / Légume test', 120],
      ['Saveurs Nomades', 'Brownie test', 80],
      ['Saveurs Nomades', 'Velouté test', 30],
      ['Saveurs Nomades', 'Plat sans fiche', 10],
      ['Comptoir Méditerranéen', 'Tarte test', 40],
    ]);
    expect(deliveryLines(ORDERS, book, '2026-11-18', 'comptoir').map((l) => l.name)).toEqual(['Tarte test']);
    expect(deliveryLines(ORDERS, book, '2026-11-19', 'tout')).toEqual([]);
  });

  it('allergènes des fiches livrées, conditionnement et éléments sans fiche', () => {
    const [surMesure, brownie, veloute, sansFiche, tarte] = deliveryLines(ORDERS, book, '2026-11-18', 'tout');
    expect(surMesure.allergens).toEqual(['Lait', 'Moutarde']);     // le légume a un facteur 0 : pas livré, pas son céleri
    expect(surMesure.detail).toBe('Sur mesure · Barquettes scellées');
    expect(brownie.allergens).toEqual(['Fruits à coque', 'Gluten', 'Œufs']);
    expect(veloute.detail).toBe('Soupe · Boîtes en carton');
    expect(veloute.allergens).toEqual([]);
    expect(sansFiche.missing).toEqual(['Plat sans fiche']);
    expect(tarte.allergens).toEqual(['Gluten', 'Lait', 'Œufs']);
    expect(packaging('Soupe du jour')).toBe('Boîtes en carton');
  });

  it('numéro, lot de la veille, DLC et température', () => {
    expect(blNumber('2026-11-18', 'tout')).toBe('BL-2026-1118-01');
    expect(blNumber('2026-11-18', 'saveurs_nomades')).toBe('BL-2026-1118-SN');
    expect(blNumber('2026-11-18', 'comptoir')).toBe('BL-2026-1118-CM');
    expect(lotOf('2026-11-18', 1)).toBe('L261117');
    expect(lotOf('2026-12-01', 1)).toBe('L261130');
    expect(dlcOf('2026-11-18', 3)).toBe('21/11/2026');
    expect(dlcOf('2026-12-30', 3)).toBe('02/01/2027');
    expect(fmtTemp('2')).toBe('+2,0 °C');
    expect(fmtTemp(' 2,46 ')).toBe('+2,5 °C');
    expect(fmtTemp('')).toBe('');
    expect(fmtTemp('chaud')).toBe('');
    expect(fmtTemp('-1').replace('−', '-')).toBe('-1,0 °C');
  });
});
