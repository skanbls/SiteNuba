import { describe, expect, it } from 'vitest';
import { lineFlags, linesTotal, prodKey, searchProducts, type DeliveryLine } from './deliveries';

const line = (o: Partial<DeliveryLine>): DeliveryLine => ({ label: '', product_id: 'p1', merc_key: null, quantity: 1, unit: '', unit_price: null, lot: '', use_by: null, ordered: null, skip: false, source: 'scan', ...o });

describe('réception des livraisons', () => {
  it('écrit la clé des produits comme la base', () => {
    expect(prodKey('Coca 33cl')).toBe('coca 33cl');
    expect(prodKey('Bière pression (Meteor)')).toBe('biere pression meteor');
    expect(prodKey('Crème  liquide ')).toBe('creme liquide');
    expect(prodKey("Fleur d'oranger")).toBe('fleur d oranger');
  });
  it('signale ce qui est à regarder', () => {
    const t = (o: Partial<DeliveryLine>, ref?: number) => lineFlags(line(o), '2026-11-25', ref).map((f) => f.text);
    expect(t({ product_id: null })).toEqual(['Produit à choisir', 'Pas dans la commande']);
    expect(t({ ordered: 6, quantity: 0, source: 'order' })).toEqual(['Commandé 6, pas livré']);
    expect(t({ ordered: 6, quantity: 5, source: 'order' })).toEqual(['Commandé 6']);
    expect(t({ ordered: 6, quantity: 6, source: 'order' })).toEqual([]);
    expect(t({ unit_price: 0.55 }, 0.5)).toEqual(['Pas dans la commande', 'Prix +10 %']);
    expect(t({ use_by: '2026-11-26' })).toEqual(['Pas dans la commande', 'DLC 26/11/2026']);
    expect(t({ product_id: null, skip: true })).toEqual(['Pas suivi en stock']);
    expect(lineFlags(line({ unit_price: 0.55 }), '2026-11-25', 0.5, false).map((f) => f.text)).toEqual(['Prix +10 %']);   // sans commande
  });
  it('compte le total et cherche sans accents', () => {
    expect(linesTotal([line({ quantity: 24, unit_price: 0.55 }), line({ quantity: 6, unit_price: 3.6 }), line({ quantity: null })])).toBe(34.8);
    const list = [{ name: 'Crème liquide', category: 'CREMERIE' }, { name: 'Courge butternut', label: 'Butternut' }, { name: 'Coca 33cl' }];
    expect(searchProducts(list, 'creme').map((p) => p.name)).toEqual(['Crème liquide']);
    expect(searchProducts(list, 'butter').map((p) => p.name)).toEqual(['Courge butternut']);
    expect(searchProducts(list, '')).toHaveLength(3);
  });
});
