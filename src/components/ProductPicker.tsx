import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import { Sheet } from './ui';
import { searchProducts, type MercProduct } from '../lib/deliveries';
import type { Product } from '../lib/types';

export interface Picked { product_id: string | null; merc_key: string | null; name: string; unit: string }

/**
 * Choisir un produit : d'abord ceux suivis en stock, puis ceux de la mercuriale Nuba pas encore suivis.
 * `mercOnly` : seulement la mercuriale (ajout à l'inventaire).
 */
export function ProductPicker({ title, products, merc, mercOnly = false, onPick, onClose, extra }: {
  title: string; products: Product[]; merc: MercProduct[]; mercOnly?: boolean; onPick: (p: Picked) => void; onClose: () => void; extra?: React.ReactNode;
}) {
  const [q, setQ] = useState('');
  const tracked = useMemo(() => new Map(products.filter((p) => p.merc_key).map((p) => [p.merc_key!, p])), [products]);
  const stock = mercOnly ? [] : searchProducts(products.filter((p) => p.active), q, 30);
  const fromMerc = searchProducts(merc.filter((m) => mercOnly || !tracked.has(m.key)), q, 40);
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="form">
        <input className="in" id="pick-search" type="search" placeholder="Chercher : carottes, crème, coca…" aria-label="Chercher un produit"
          value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        {stock.length > 0 && (
          <div className="list" data-testid="pick-stock">
            {stock.map((p) => (
              <button type="button" className="row" key={p.id} data-pick={p.name} onClick={() => onPick({ product_id: p.id, merc_key: p.merc_key ?? null, name: p.name, unit: p.unit })}>
                <span className="grow"><span className="t">{p.name}</span><span className="sub">{[p.unit, p.category, 'suivi en stock'].filter(Boolean).join(' · ')}</span></span>
                <span className="chev"><Icon name="chev" size={18} /></span>
              </button>
            ))}
          </div>
        )}
        {fromMerc.length > 0 ? (
          <>
            {!mercOnly && <span className="sub">Dans la mercuriale Nuba, pas encore suivis :</span>}
            <div className="list" data-testid="pick-merc">
              {fromMerc.map((m) => {
                const p = tracked.get(m.key);
                return (
                  <button type="button" className="row" key={m.key} data-pick={m.name}
                    onClick={() => onPick({ product_id: p?.id ?? null, merc_key: m.key, name: m.name, unit: m.unit })}>
                    <span className="grow"><span className="t">{m.name}</span><span className="sub">{[m.unit, m.category, m.supplier].filter(Boolean).join(' · ')}</span></span>
                    <span className="end">{p?.active && <span className="pill ok">Déjà suivi</span>}<span className="chev"><Icon name="chev" size={18} /></span></span>
                  </button>
                );
              })}
            </div>
          </>
        ) : stock.length === 0 ? (
          <p className="note">{merc.length === 0 ? "La mercuriale Nuba n'est pas encore arrivée dans l'appli : le gérant doit installer le nouveau script Google." : 'Aucun produit ne correspond.'}</p>
        ) : null}
        {extra}
      </div>
    </Sheet>
  );
}
