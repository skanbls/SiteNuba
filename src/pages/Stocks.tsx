import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Sheet, Spinner, useToast } from '../components/ui';
import { ProductPicker, type Picked } from '../components/ProductPicker';
import { useMercProducts, useOrders, useProducts, useRefresh, useSuppliers } from '../lib/data';
import { frError, supabase } from '../lib/supabase';
import type { Product, Supplier } from '../lib/types';
import type { MercProduct } from '../lib/deliveries';
import { useCan } from '../lib/rights';

const CATEGORIES = ['Bar', 'Cave', 'Cuisine', 'Consommables'];
export const qty = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
const euro = (v: number) => v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const num = (s: string) => Number(s.replace(',', '.'));

/** Stocks : quantités, seuils d'alerte, inventaire. */
export default function Stocks() {
  const can = useCan();
  const editor = can('stocks');
  const toast = useToast();
  const refresh = useRefresh();
  const products = useProducts();
  const suppliers = useSuppliers();
  const orders = useOrders();
  const [cat, setCat] = useState('Tous');
  const [search, setSearch] = useState('');
  const [counting, setCounting] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [edit, setEdit] = useState<Product | 'new' | null>(null);
  const closeEdit = useCallback(() => setEdit(null), []);
  // Ajouter un produit : on le choisit dans la mercuriale Nuba (toute l'équipe, à l'inventaire par exemple).
  const merc = useMercProducts();
  const [adding, setAdding] = useState(false);
  const mercReady = (merc.data ?? []).length > 0;

  async function addFromMerc(p: Picked) {
    setAdding(false);
    if (!p.merc_key) return;
    const { error } = await supabase.rpc('stock_add_from_merc', { p_keys: [p.merc_key] });
    if (error) return toast(frError(error), 'bad');
    await refresh('products', 'tasks');
    setSearch(p.name);
    setCat('Tous');
    toast(`${p.name} est suivi en stock${counting ? ' : saisis sa quantité' : ''}`);
  }

  const all = products.data ?? [];
  const active = all.filter((p) => p.active);
  const supplierName = useMemo(() => new Map((suppliers.data ?? []).map((s) => [s.id, s.name])), [suppliers.data]);
  const onOrder = useMemo(() => {
    const ids = new Set<string>();
    for (const o of orders.data ?? []) if (o.status === 'draft' || o.status === 'sent') for (const l of o.order_lines) ids.add(l.product_id);
    return ids;
  }, [orders.data]);
  const low = active.filter((p) => p.threshold > 0 && p.quantity < p.threshold);
  const cats = ['Tous', ...Array.from(new Set(active.map((p) => p.category))).sort((a, b) => a.localeCompare(b, 'fr'))];
  const needle = search.trim().toLowerCase();
  const shown = (editor ? all : active)
    .filter((p) => cat === 'Tous' || p.category === cat)
    .filter((p) => !needle || p.name.toLowerCase().includes(needle));
  const changed = Object.entries(counts).filter(([id, v]) => {
    const p = all.find((x) => x.id === id);
    return p && v.trim() !== '' && !Number.isNaN(num(v)) && num(v) >= 0 && num(v) !== p.quantity;
  });

  async function adjust(p: Product, delta: number) {
    setBusy(p.id);
    const { error } = await supabase.rpc('adjust_stock', { p_product: p.id, p_delta: delta });
    setBusy('');
    if (error) return toast(frError(error), 'bad');
    await refresh('products', 'tasks');
  }

  async function saveCount() {
    setBusy('count');
    const { data, error } = await supabase.rpc('count_stock', { p_counts: changed.map(([id, v]) => ({ id, quantity: num(v) })) });
    setBusy('');
    if (error) return toast(frError(error), 'bad');
    await refresh('products', 'tasks');
    setCounts({});
    setCounting(false);
    const n = data as number;
    toast(n === 0 ? 'Aucune quantité à changer' : `Inventaire enregistré : ${n} quantité${n > 1 ? 's' : ''} mise${n > 1 ? 's' : ''} à jour`);
  }

  return (
    <Layout title="Stocks" right={(editor || mercReady) && <button type="button" className="btn sm pri" onClick={() => (mercReady ? setAdding(true) : setEdit('new'))}><Icon name="plus" size={16} />Produit</button>}>
      {products.isLoading ? <Loading /> : products.error ? <div className="list"><p className="empty err">{frError(products.error)}</p></div> : (
        <>
          <div className="stats">
            <div className="stat"><div className="v">{active.length}</div><div className="k">produits suivis</div></div>
            <div className="stat"><div className="v">{low.length}</div><div className="k">sous le seuil</div></div>
            {editor
              ? <div className="stat"><div className="v">{euro(active.reduce((t, p) => t + p.quantity * p.unit_price, 0))}</div><div className="k">valeur du stock</div></div>
              : <div className="stat"><div className="v">{active.filter((p) => onOrder.has(p.id)).length}</div><div className="k">en commande</div></div>}
          </div>

          {low.some((p) => !onOrder.has(p.id)) && !counting && (
            <Link className="btn pri block" to="/commandes"><Icon name="truck" />Préparer les commandes ({low.filter((p) => !onOrder.has(p.id)).length} à commander)</Link>
          )}

          <section className="sec">
            <div className="acts">
              <input className="in" id="stock-search" style={{ flex: '2 1 180px' }} type="search" placeholder="Chercher un produit" aria-label="Chercher un produit" value={search} onChange={(e) => setSearch(e.target.value)} />
              {!counting && active.length > 0 && <button type="button" className="btn" onClick={() => { setCounts({}); setCounting(true); }}>Faire l'inventaire</button>}
            </div>
            {cats.length > 2 && <Chips value={cat} options={cats.map((c) => [c, c] as [string, string])} onChange={setCat} label="Catégorie" />}
            {counting && <p className="note">Saisis la quantité comptée pour chaque produit, puis enregistre. Les lignes laissées vides ne changent pas.{mercReady ? ' Un produit manque ? Touche « Produit » et choisis-le dans la mercuriale.' : ''}</p>}

            <div className="list">
              {shown.length === 0 && <p className="empty">{all.length === 0 ? (editor ? 'Aucun produit pour l\'instant. Ajoute le premier avec le bouton « Produit ».' : 'Aucun produit pour l\'instant : le gérant doit créer le catalogue.') : 'Aucun produit ne correspond.'}</p>}
              {shown.map((p) => {
                const state: [string, string] | null = !p.active ? ['', 'Retiré'] : p.threshold > 0 && p.quantity === 0 ? ['bad', 'Rupture'] : p.threshold > 0 && p.quantity < p.threshold ? ['warn', 'Bas'] : null;
                return (
                  <div className="row wrap" key={p.id} data-product={p.name}>
                    <div className="grow">
                      <span className="t">
                        {p.name}{' '}
                        {state && <span className={`pill ${state[0]}`}>{state[1]}</span>}{' '}
                        {p.active && onOrder.has(p.id) && <span className="pill info">Commandé</span>}{' '}
                        {editor && mercReady && p.active && !p.merc_key && <span className="pill warn" data-hors-mercuriale>Hors mercuriale</span>}
                      </span>
                      <span className="sub">{[p.unit, p.threshold > 0 ? `seuil ${qty(p.threshold)}` : 'sans seuil', p.supplier_id ? supplierName.get(p.supplier_id) : 'sans fournisseur'].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div className="end">
                      {!p.active ? null : counting ? (
                        <input className="in qty num" inputMode="decimal" aria-label={`Quantité comptée de ${p.name}`} placeholder={qty(p.quantity)} value={counts[p.id] ?? ''}
                          onChange={(e) => setCounts((s) => ({ ...s, [p.id]: e.target.value }))} />
                      ) : (
                        <div className="step">
                          <button type="button" disabled={busy === p.id || p.quantity <= 0} onClick={() => void adjust(p, -1)} aria-label={`Retirer 1 ${p.name}`}><Icon name="minus" size={16} /></button>
                          <span className="qty" style={{ display: 'grid', placeItems: 'center', height: 40, padding: '0 8px' }} aria-label={`Quantité de ${p.name}`}>{qty(p.quantity)}</span>
                          <button type="button" disabled={busy === p.id} onClick={() => void adjust(p, 1)} aria-label={`Ajouter 1 ${p.name}`}><Icon name="plus" size={16} /></button>
                        </div>
                      )}
                      {editor && !counting && <button type="button" className="btn sm" onClick={() => setEdit(p)} aria-label={`Modifier ${p.name}`}><Icon name="cog" size={16} /></button>}
                    </div>
                  </div>
                );
              })}
            </div>

            {counting && (
              <div className="acts">
                <button type="button" className="btn" disabled={busy === 'count'} onClick={() => { setCounting(false); setCounts({}); }}>Annuler</button>
                <button type="button" className="btn pri" disabled={busy === 'count' || changed.length === 0} onClick={() => void saveCount()}>
                  {busy === 'count' ? <Spinner /> : `Enregistrer l'inventaire (${changed.length})`}
                </button>
              </div>
            )}
            {!counting && <p className="note">Les boutons − et + ajustent le stock au fil du service. « Faire l'inventaire » sert au comptage complet. Chaque changement est enregistré avec son auteur.</p>}
          </section>
        </>
      )}
      {edit && <ProductSheet product={edit} suppliers={(suppliers.data ?? []).filter((s) => s.active)} categories={Array.from(new Set([...CATEGORIES, ...all.map((p) => p.category)]))} merc={merc.data ?? []} products={all} onClose={closeEdit} />}
      {adding && (
        <ProductPicker title="Ajouter un produit de la mercuriale" products={all} merc={merc.data ?? []} mercOnly onPick={(p) => void addFromMerc(p)} onClose={() => setAdding(false)}
          extra={editor ? <button type="button" className="btn block" onClick={() => { setAdding(false); setEdit('new'); }}>Produit hors mercuriale (consommables…)</button> : undefined} />
      )}
    </Layout>
  );
}

/* ---------- Créer ou modifier un produit (gérant) ---------- */
function ProductSheet({ product, suppliers, categories, merc, products, onClose }: { product: Product | 'new'; suppliers: Supplier[]; categories: string[]; merc: MercProduct[]; products: Product[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = product === 'new' ? null : product;
  const [name, setName] = useState(old?.name ?? '');
  const [category, setCategory] = useState(old?.category ?? 'Bar');
  const [unit, setUnit] = useState(old?.unit ?? '');
  const [threshold, setThreshold] = useState(old ? qty(old.threshold) : '');
  const [target, setTarget] = useState(old?.target != null ? qty(old.target) : '');
  const [price, setPrice] = useState(old ? String(old.unit_price).replace('.', ',') : '');
  const [supplier, setSupplier] = useState(old?.supplier_id ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const linked = old?.merc_key ? merc.find((m) => m.key === old.merc_key) : undefined;
  // Relié à la mercuriale : ces champs la suivent ; seuls le seuil et la quantité voulue se règlent ici.
  const fromMerc = !!old?.merc_key;

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('products', 'tasks');
    toast(done);
    onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const th = threshold.trim() === '' ? 0 : num(threshold);
    const tg = target.trim() === '' ? null : num(target);
    const pr = price.trim() === '' ? 0 : num(price);
    if ([th, tg ?? 0, pr].some((v) => Number.isNaN(v) || v < 0)) return setErr('Vérifie les nombres saisis.');
    if (tg !== null && tg < th) return setErr('La quantité voulue doit être au moins égale au seuil.');
    const row = { name: name.trim(), category: category.trim() || 'Bar', unit: unit.trim(), threshold: th, target: tg, unit_price: pr, supplier_id: supplier || null };
    void (old ? run(() => supabase.from('products').update(row).eq('id', old.id), 'Produit enregistré') : run(() => supabase.from('products').insert(row), 'Produit ajouté'));
  }

  return (
    <Sheet title={old ? old.name : 'Ajouter un produit'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        {old && merc.length > 0 && (old.merc_key ? (
          <p className="note" data-testid="prod-merc">
            <span className="pill ok">Mercuriale Nuba</span> Relié à « {linked?.name ?? old.merc_key} » : nom, catégorie, unité, prix et fournisseur suivent la mercuriale.{' '}
            <button type="button" className="link" disabled={busy} onClick={() => void run(() => supabase.rpc('link_product_merc', { p_product: old.id, p_key: '' }), 'Produit délié de la mercuriale')}>Délier</button>
          </p>
        ) : (
          <button type="button" className="btn block" id="prod-link" onClick={() => setLinking(true)}><Icon name="list" />Relier à un produit de la mercuriale</button>
        ))}
        {linking && old && (
          <ProductPicker title={`Relier « ${old.name} »`} products={products} merc={merc} mercOnly onClose={() => setLinking(false)}
            onPick={(p) => { setLinking(false); if (p.merc_key) void run(() => supabase.rpc('link_product_merc', { p_product: old.id, p_key: p.merc_key }), 'Produit relié à la mercuriale'); }} />
        )}
        <Field label="Nom">
          <input className="in" id="prod-name" readOnly={fromMerc} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </Field>
        <div className="two">
          <Field label="Catégorie">
            <input className="in" id="prod-category" readOnly={fromMerc} list="prod-categories" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} />
            <datalist id="prod-categories">{categories.map((c) => (<option key={c} value={c} />))}</datalist>
          </Field>
          <Field label="Unité" hint="Ce qu'on compte : bouteille 70 cl, kg, fût 30 L…">
            <input className="in" id="prod-unit" readOnly={fromMerc} value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={40} />
          </Field>
        </div>
        <div className="two">
          <Field label="Seuil d'alerte" hint="En dessous, le produit est à commander. Vide : pas d'alerte.">
            <input className="in" id="prod-threshold" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          </Field>
          <Field label="Quantité voulue" hint="Niveau à retrouver après une commande. Vide : deux fois le seuil.">
            <input className="in" id="prod-target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
        </div>
        <div className="two">
          <Field label="Prix d'achat par unité (€ HT)">
            <input className="in" id="prod-price" readOnly={fromMerc} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
          <Field label="Fournisseur">
            <select className="in" id="prod-supplier" disabled={fromMerc} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">Aucun</option>
              {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
            </select>
          </Field>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && (
          <button type="button" className="btn block" disabled={busy}
            onClick={() => void run(() => supabase.from('products').update({ active: !old.active }).eq('id', old.id), old.active ? 'Produit retiré du suivi' : 'Produit remis dans le suivi')}>
            {old.active ? 'Retirer ce produit du suivi' : 'Remettre ce produit dans le suivi'}
          </button>
        )}
        <p className="note">{old ? "La quantité en stock se change dans la liste, avec − et +, ou par un inventaire." : 'Le produit est créé avec un stock à zéro : compte-le ensuite dans la liste.'}</p>
      </form>
    </Sheet>
  );
}
