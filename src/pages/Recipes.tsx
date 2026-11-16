import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useProducts, useRecipes, useRefresh } from '../lib/data';
import { useMe } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { ALLERGENS, type Product, type Recipe } from '../lib/types';

const CATEGORIES = ['Cuisine', 'Cocktails', 'Boissons', 'Desserts'];
const num = (s: string) => Number(s.replace(',', '.'));
const fr = (v: number, d = 2) => v.toLocaleString('fr-FR', { maximumFractionDigits: d });
const euro = (v: number) => v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

interface Line { product_id: string; label: string; quantity: string; unit: string; pack_size: string; manual_cost: string }

/** Coût d'une ligne : part du produit utilisée, ou coût saisi à la main. */
function lineCost(l: { product_id: string | null; quantity: number; pack_size: number; manual_cost: number | null }, price: Map<string, number>): number {
  if (l.product_id && price.has(l.product_id)) return (l.quantity / (l.pack_size || 1)) * (price.get(l.product_id) ?? 0);
  return l.manual_cost ?? 0;
}

/** Fiches techniques : recettes, grammages, allergènes ; coûts et marges pour le gérant. */
export default function Recipes() {
  const me = useMe();
  const gerant = me.role === 'gerant';
  const recipes = useRecipes();
  const products = useProducts();
  const price = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p.unit_price])), [products.data]);
  const [cat, setCat] = useState('Toutes');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Recipe | 'new' | null>(null);
  const [table, setTable] = useState(false);
  const close = useCallback(() => setOpen(null), []);
  const closeTable = useCallback(() => setTable(false), []);

  const all = (recipes.data ?? []).filter((r) => r.active || gerant);
  const cats = ['Toutes', ...Array.from(new Set(all.map((r) => r.category))).sort((a, b) => a.localeCompare(b, 'fr'))];
  const needle = search.trim().toLowerCase();
  const shown = all.filter((r) => cat === 'Toutes' || r.category === cat).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  const costOf = (r: Recipe) => r.recipe_items.reduce((t, i) => t + lineCost(i, price), 0) / (r.portions || 1);

  return (
    <Layout title="Fiches techniques" right={gerant && <button type="button" className="btn sm pri" onClick={() => setOpen('new')}><Icon name="plus" size={16} />Fiche</button>}>
      <div className="acts">
        <input className="in" id="recipe-search" style={{ flex: '2 1 180px' }} type="search" placeholder="Chercher une recette" aria-label="Chercher une recette" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn" onClick={() => setTable(true)}>Tableau des allergènes</button>
      </div>
      {cats.length > 2 && <Chips value={cat} options={cats.map((c) => [c, c] as [string, string])} onChange={setCat} label="Catégorie" />}
      {recipes.isLoading ? <Loading /> : recipes.error ? <div className="list"><p className="empty err">{frError(recipes.error)}</p></div> : (
        <div className="list">
          {shown.length === 0 && <p className="empty">{all.length === 0 ? (gerant ? 'Aucune fiche pour l\'instant. Crée la première avec le bouton « Fiche ».' : 'Aucune fiche pour l\'instant.') : 'Aucune fiche ne correspond.'}</p>}
          {shown.map((r) => {
            const cost = costOf(r);
            const ht = r.sale_price != null ? r.sale_price / (1 + r.vat / 100) : null;
            return (
              <button type="button" className="row wrap" key={r.id} data-recipe={r.name} onClick={() => setOpen(r)} style={r.active ? undefined : { opacity: 0.6 }}>
                <span className="grow">
                  <span className="t">{r.name}</span>
                  <span className="sub">{[r.category, `${r.recipe_items.length} ingrédient${r.recipe_items.length > 1 ? 's' : ''}`, r.allergens.length ? `allergènes : ${r.allergens.join(', ')}` : 'aucun allergène déclaré'].join(' · ')}</span>
                </span>
                <span className="end">
                  {gerant && ht != null && ht > 0 && cost > 0 && <span className={`pill ${cost / ht > 0.35 ? 'warn' : 'ok'}`}>{fr((cost / ht) * 100, 0)} % de coût</span>}
                  <span className="chev"><Icon name="chev" size={18} /></span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {open && (gerant
        ? <RecipeForm key={open === 'new' ? 'new' : open.id} recipe={open} products={(products.data ?? []).filter((p) => p.active)} price={price} onClose={close} />
        : open !== 'new' && <RecipeView recipe={open} onClose={close} />)}
      {table && (
        <Sheet title="Tableau des allergènes" onClose={closeTable}>
          <p className="note">À consulter avant de répondre à un client. Il reprend les allergènes déclarés sur chaque fiche : une fiche incomplète donne un tableau incomplet.</p>
          <div className="list">
            {all.filter((r) => r.active).length === 0 && <p className="empty">Aucune fiche pour l'instant.</p>}
            {all.filter((r) => r.active).map((r) => (
              <div className="row wrap" key={r.id}>
                <div className="grow"><span className="t">{r.name}</span><span className="sub">{r.category}</span></div>
                <div className="end" style={{ flexWrap: 'wrap', justifyContent: 'flex-end', flex: '1 1 160px' }}>
                  {r.allergens.length === 0 ? <span className="pill">Aucun déclaré</span> : r.allergens.map((a) => (<span className="pill warn" key={a}>{a}</span>))}
                </div>
              </div>
            ))}
          </div>
        </Sheet>
      )}
    </Layout>
  );
}

/* ---------- Lecture d'une fiche (équipe) ---------- */
function RecipeView({ recipe: r, onClose }: { recipe: Recipe; onClose: () => void }) {
  const items = [...r.recipe_items].sort((a, b) => a.position - b.position);
  return (
    <Sheet title={r.name} onClose={onClose}>
      <p className="sub">{r.category} · pour {fr(r.portions)} portion{r.portions > 1 ? 's' : ''}</p>
      <Section title="Ingrédients">
        <div className="list">
          {items.length === 0 && <p className="empty">Aucun ingrédient noté.</p>}
          {items.map((i) => (<div className="row" key={i.id}><span className="grow t" style={{ fontWeight: 500 }}>{i.label}</span><span className="t num">{fr(i.quantity, 3)} {i.unit}</span></div>))}
        </div>
      </Section>
      {r.method && <Section title="Préparation"><p style={{ whiteSpace: 'pre-wrap' }}>{r.method}</p></Section>}
      <Section title="Allergènes">
        <div className="chips" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
          {r.allergens.length === 0 ? <span className="pill">Aucun allergène déclaré</span> : r.allergens.map((a) => (<span className="pill warn" key={a}>{a}</span>))}
        </div>
      </Section>
    </Sheet>
  );
}

/* ---------- Créer ou modifier une fiche (gérant) ---------- */
function RecipeForm({ recipe, products, price, onClose }: { recipe: Recipe | 'new'; products: Product[]; price: Map<string, number>; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = recipe === 'new' ? null : recipe;
  const [name, setName] = useState(old?.name ?? '');
  const [category, setCategory] = useState(old?.category ?? 'Cuisine');
  const [portions, setPortions] = useState(old ? fr(old.portions) : '1');
  const [sale, setSale] = useState(old?.sale_price != null ? String(old.sale_price).replace('.', ',') : '');
  const [vat, setVat] = useState(String(old?.vat ?? 10));
  const [method, setMethod] = useState(old?.method ?? '');
  const [allergens, setAllergens] = useState<string[]>(old?.allergens ?? []);
  const [lines, setLines] = useState<Line[]>(() =>
    old ? [...old.recipe_items].sort((a, b) => a.position - b.position).map((i) => ({ product_id: i.product_id ?? '', label: i.label, quantity: fr(i.quantity, 3), unit: i.unit, pack_size: fr(i.pack_size, 3), manual_cost: i.manual_cost != null ? String(i.manual_cost).replace('.', ',') : '' })) : [],
  );
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const patch = (i: number, p: Partial<Line>) => setLines((a) => a.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const total = lines.reduce((t, l) => t + lineCost({ product_id: l.product_id || null, quantity: num(l.quantity) || 0, pack_size: num(l.pack_size) || 1, manual_cost: l.manual_cost.trim() === '' ? null : num(l.manual_cost) }, price), 0);
  const perPortion = total / (num(portions) || 1);
  const ht = sale.trim() === '' ? null : num(sale) / (1 + Number(vat) / 100);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('recipes');
    toast(done);
    onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if ([portions, ...lines.map((l) => l.quantity)].some((v) => Number.isNaN(num(v))) || num(portions) <= 0) return setErr('Vérifie les quantités et le nombre de portions.');
    const p = { name, category, portions: num(portions), sale_price: sale.trim() === '' ? '' : num(sale), vat: Number(vat), method, allergens, active: old?.active ?? true };
    const items = lines.filter((l) => num(l.quantity) > 0).map((l) => ({
      product_id: l.product_id, label: l.label.trim() || products.find((x) => x.id === l.product_id)?.name || 'Ingrédient', quantity: num(l.quantity), unit: l.unit.trim(),
      pack_size: num(l.pack_size) > 0 ? num(l.pack_size) : 1, manual_cost: l.product_id || l.manual_cost.trim() === '' ? '' : num(l.manual_cost),
    }));
    void run(() => supabase.rpc('save_recipe', { p_id: old?.id ?? null, p, p_items: items }), old ? 'Fiche enregistrée' : 'Fiche créée');
  }

  return (
    <Sheet title={old ? old.name : 'Nouvelle fiche technique'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <div className="two">
          <Field label="Nom"><input className="in" id="rec-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
          <Field label="Catégorie">
            <input className="in" id="rec-category" list="rec-categories" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} />
            <datalist id="rec-categories">{CATEGORIES.map((c) => (<option key={c} value={c} />))}</datalist>
          </Field>
        </div>
        <div className="two">
          <Field label="Nombre de portions"><input className="in" id="rec-portions" inputMode="decimal" value={portions} onChange={(e) => setPortions(e.target.value)} required /></Field>
          <Field label="Prix de vente d'une portion (€ TTC)"><input className="in" id="rec-sale" inputMode="decimal" value={sale} onChange={(e) => setSale(e.target.value)} /></Field>
        </div>
        <Field label="TVA" hint="10 % pour la restauration, 20 % pour les boissons alcoolisées.">
          <select className="in" id="rec-vat" value={vat} onChange={(e) => setVat(e.target.value)}><option value="10">10 %</option><option value="20">20 %</option><option value="5.5">5,5 %</option></select>
        </Field>

        <div className="field">
          <span>Ingrédients</span>
          <small>Choisis un produit du stock pour que son coût se calcule tout seul, ou saisis un ingrédient libre avec son coût.</small>
          {lines.map((l, i) => {
            const prod = products.find((x) => x.id === l.product_id);
            return (
              <div className="list" key={i} style={{ padding: 10, display: 'grid', gap: 8 }} data-line={i + 1}>
                <div className="edit-row">
                  <select className="in" aria-label={`Ingrédient ${i + 1}, produit du stock`} value={l.product_id} onChange={(e) => { const x = products.find((q) => q.id === e.target.value); patch(i, { product_id: e.target.value, label: x ? x.name : l.label }); }}>
                    <option value="">Ingrédient libre</option>
                    {products.map((x) => (<option key={x.id} value={x.id}>{x.name}{x.unit ? ` (${x.unit})` : ''}</option>))}
                  </select>
                  <button type="button" className="btn sm no" onClick={() => setLines((a) => a.filter((_, k) => k !== i))} aria-label={`Retirer l'ingrédient ${i + 1}`}><Icon name="x" size={16} /></button>
                </div>
                {!l.product_id && <input className="in" aria-label={`Ingrédient ${i + 1}, nom`} placeholder="Nom de l'ingrédient" value={l.label} onChange={(e) => patch(i, { label: e.target.value })} maxLength={80} />}
                <div className="hours-row">
                  <input className="in" inputMode="decimal" aria-label={`Ingrédient ${i + 1}, quantité`} placeholder="Quantité" value={l.quantity} onChange={(e) => patch(i, { quantity: e.target.value })} />
                  <input className="in" aria-label={`Ingrédient ${i + 1}, unité`} placeholder="cl, g, pièce" value={l.unit} onChange={(e) => patch(i, { unit: e.target.value })} maxLength={20} />
                  {l.product_id
                    ? <input className="in" inputMode="decimal" aria-label={`Ingrédient ${i + 1}, contenance du produit`} placeholder="Contenance" value={l.pack_size} onChange={(e) => patch(i, { pack_size: e.target.value })} />
                    : <input className="in" inputMode="decimal" aria-label={`Ingrédient ${i + 1}, coût`} placeholder="Coût (€)" value={l.manual_cost} onChange={(e) => patch(i, { manual_cost: e.target.value })} />}
                </div>
                {prod && <small className="sub">Contenance : combien de {l.unit || 'unités'} dans un « {prod.unit || prod.name} » à {euro(prod.unit_price)}. Par exemple 70 pour une bouteille de 70 cl.</small>}
              </div>
            );
          })}
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setLines((a) => [...a, { product_id: '', label: '', quantity: '', unit: '', pack_size: '1', manual_cost: '' }])}><Icon name="plus" size={16} />Ajouter un ingrédient</button>
        </div>

        <div className="stats">
          <div className="stat"><div className="v">{euro(perPortion)}</div><div className="k">coût par portion</div></div>
          <div className="stat"><div className="v">{ht != null && ht > 0 ? `${fr((perPortion / ht) * 100, 0)} %` : '–'}</div><div className="k">du prix hors taxe</div></div>
          <div className="stat"><div className="v">{ht != null ? euro(ht - perPortion) : '–'}</div><div className="k">marge par portion</div></div>
        </div>

        <Field label="Préparation"><textarea className="in" id="rec-method" value={method} onChange={(e) => setMethod(e.target.value)} maxLength={4000} style={{ minHeight: 110 }} /></Field>
        <div className="field">
          <span>Allergènes présents</span>
          <div className="chips" role="group" aria-label="Allergènes" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
            {ALLERGENS.map((a) => (
              <button type="button" key={a} className="chip" aria-pressed={allergens.includes(a)} onClick={() => setAllergens((x) => (x.includes(a) ? x.filter((y) => y !== a) : [...x, a]))}>{a}</button>
            ))}
          </div>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && (confirm ? (
          <div className="acts">
            <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
            <button type="button" className="btn no" disabled={busy} onClick={() => void run(() => supabase.from('recipes').delete().eq('id', old.id), 'Fiche supprimée')}>Supprimer définitivement</button>
          </div>
        ) : <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Supprimer cette fiche</button>)}
        <p className="note">Les coûts suivent les prix d'achat du stock. L'équipe voit les ingrédients, la préparation et les allergènes, pas les coûts.</p>
      </form>
    </Sheet>
  );
}
