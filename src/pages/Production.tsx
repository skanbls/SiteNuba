import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Section, Sheet, useToast } from '../components/ui';
import { useMercCosts, useMercIngredients, useMercLines, useMercOrders, useMercPrices, useMercRecipes, useMercSources } from '../lib/data';
import {
  BRAND_LABEL, Book, ROLE_LABEL, components, fmtEuro, fmtPct, fmtQty, orderIssues, orderNeeds, shopping,
  type Brand, type MercCost, type MercIngredient, type MercOrder, type MercPrice, type MercRecipe, type MercSource, type Need,
} from '../lib/production';
import { useCan } from '../lib/rights';
import { useSession } from '../lib/session';
import { frError } from '../lib/supabase';
import { ago, dayKey, fmtDayLong, fromDayKey } from '../lib/time';

type Tab = 'commandes' | 'courses' | 'fiches';
type BrandFilter = 'tout' | Brand;
const SHORT: Record<Brand, string> = { saveurs_nomades: 'Saveurs Nomades', comptoir: 'Comptoir' };
const longDay = (d: string) => { const s = fmtDayLong(fromDayKey(d)); return s.charAt(0).toUpperCase() + s.slice(1); };

/**
 * Production : les commandes clients des mercuriales Saveurs Nomades et Comptoir Méditerranéen,
 * avec, pour chacune, les quantités à produire et la liste de courses du jour de livraison.
 * Tout vient des feuilles Google : on les modifie là-bas, l'appli suit toute seule.
 */
export default function Production() {
  const can = useCan();
  const money = can('fiches');
  const { profile } = useSession();
  const boss = profile?.role === 'gerant';
  const today = dayKey(new Date());
  const [tab, setTab] = useState<Tab>('commandes');
  const [brand, setBrand] = useState<BrandFilter>('tout');
  const [shopDay, setShopDay] = useState('');
  const sources = useMercSources();
  const recipes = useMercRecipes();
  const lines = useMercLines();
  const orders = useMercOrders();
  const ingredients = useMercIngredients();
  const prices = useMercPrices(money);
  const costs = useMercCosts(money);

  const book = useMemo(() => new Book(recipes.data ?? [], lines.data ?? []), [recipes.data, lines.data]);
  // La mercuriale Nuba (la carte) vit dans Fiches techniques : ici, Saveurs Nomades et Comptoir.
  const mijote = (sources.data ?? []).filter((s): s is MercSource & { brand: Brand } => s.brand !== 'nuba');
  const queries = [sources, recipes, lines, orders, ingredients];
  const loading = queries.some((q) => q.isLoading);
  const error = queries.find((q) => q.error)?.error;
  const synced = mijote.some((s) => s.synced_at);
  const inBrand = <T extends { brand: Brand }>(x: T) => brand === 'tout' || x.brand === brand;
  const allOrders = (orders.data ?? []).filter(inBrand);

  const openShopping = useCallback((day: string) => {
    setShopDay(day);
    setTab('courses');
  }, []);

  return (
    <Layout title="Production">
      <Chips value={tab} options={[['commandes', 'Commandes'], ['courses', 'Liste de courses'], ['fiches', 'Fiches']]} onChange={setTab} label="Rubrique" />
      <Chips value={brand} options={[['tout', 'Les deux'], ['saveurs_nomades', 'Saveurs Nomades'], ['comptoir', 'Comptoir']]} onChange={setBrand} label="Mercuriale" />
      {loading ? <Loading /> : error ? <div className="list"><p className="empty err">{frError(error)}</p></div> : !synced ? (
        <div className="list">
          <p className="empty">
            Les mercuriales ne sont pas encore reliées à l'appli.{' '}
            {boss ? <>Relie-les dans <Link className="link" to="/reglages">Administration</Link>, rubrique « Mercuriales Google Sheets ».</> : 'Le gérant les relie dans Administration.'}
          </p>
        </div>
      ) : tab === 'commandes' ? (
        <Orders orders={allOrders} book={book} today={today} money={money} costs={costs.data ?? []} onShopping={openShopping} />
      ) : tab === 'courses' ? (
        <Shopping orders={allOrders} book={book} today={today} day={shopDay} setDay={setShopDay} ingredients={ingredients.data ?? []} prices={money ? prices.data ?? [] : []} money={money} />
      ) : (
        <Recipes recipes={(recipes.data ?? []).filter(inBrand)} book={book} money={money} costs={costs.data ?? []} />
      )}
      {synced && <SyncInfo sources={mijote} boss={boss} />}
    </Layout>
  );
}

function SyncInfo({ sources, boss }: { sources: (MercSource & { brand: Brand })[]; boss: boolean }) {
  return (
    <p className="note" data-testid="merc-sync">
      Mis à jour depuis Google Sheets :{' '}
      {sources.map((s, i) => (
        <span key={s.brand}>
          {i > 0 && ' · '}
          {SHORT[s.brand]} {s.synced_at ? ago(s.synced_at) : 'jamais'}
          {boss && s.sheet_url && <> (<a className="link" href={s.sheet_url} target="_blank" rel="noopener noreferrer">ouvrir</a>)</>}
        </span>
      ))}
      . Les fiches et les commandes se modifient dans les feuilles ; l'appli suit toute seule.
    </p>
  );
}

/* ---------- Commandes ---------- */
function Orders({ orders, book, today, money, costs, onShopping }: { orders: MercOrder[]; book: Book; today: string; money: boolean; costs: MercCost[]; onShopping: (day: string) => void }) {
  const [past, setPast] = useState(false);
  const [open, setOpen] = useState<MercOrder | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const shown = orders
    .filter((o) => (past ? o.day < today : o.day >= today))
    .sort((a, b) => (past ? b.day.localeCompare(a.day) : a.day.localeCompare(b.day)) || a.brand.localeCompare(b.brand) || a.position - b.position)
    .slice(0, past ? 120 : undefined);
  const days = Array.from(new Set(shown.map((o) => o.day)));
  return (
    <>
      <div className="acts">
        <button type="button" className="chip" aria-pressed={past} onClick={() => setPast(!past)}>{past ? 'Voir les commandes à venir' : 'Voir les commandes passées'}</button>
      </div>
      {days.length === 0 && <div className="list"><p className="empty">{past ? 'Aucune commande passée.' : 'Aucune commande à venir dans les mercuriales.'}</p></div>}
      {days.map((d) => {
        const list = shown.filter((o) => o.day === d);
        const portions = list.reduce((t, o) => t + o.portions, 0);
        return (
          <Section key={d} title={`${longDay(d)} · ${portions} portions`} right={<button type="button" className="link" onClick={() => onShopping(d)}>Liste de courses</button>}>
            <div className="list">
              {list.map((o) => {
                const comps = components(o, book);
                const issues = orderIssues(comps, book);
                return (
                  <button type="button" className="row wrap" key={o.id} data-order={o.dish} onClick={() => setOpen(o)}>
                    <span className="grow">
                      <span className="t">{o.dish}</span>
                      <span className="sub">{[SHORT[o.brand], `${o.portions} portions`, o.formula].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="end">
                      {issues.length ? <span className="pill bad">Fiche manquante</span> : o.check_status && o.check_status !== 'OK' ? <span className="pill warn">À vérifier</span> : <span className="pill ok">Fiches OK</span>}
                      <span className="chev"><Icon name="chev" size={18} /></span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        );
      })}
      {open && <OrderSheet order={open} book={book} money={money} costs={costs} onShopping={onShopping} onClose={close} />}
    </>
  );
}

function OrderSheet({ order, book, money, costs, onShopping, onClose }: { order: MercOrder; book: Book; money: boolean; costs: MercCost[]; onShopping: (day: string) => void; onClose: () => void }) {
  const comps = components(order, book);
  const issues = orderIssues(comps, book);
  const needs = orderNeeds(order, comps, book);
  const costOf = (r: MercRecipe | null) => costs.find((c) => r && c.brand === r.brand && c.name === r.name);
  const total = comps.reduce<number | null>((t, c) => {
    const k = costOf(c.recipe)?.cost_portion_losses;
    return t == null || k == null ? null : t + k * c.factor * order.portions;
  }, 0);
  return (
    <Sheet title={order.dish} onClose={onClose}>
      <p className="sub">{[longDay(order.day), BRAND_LABEL[order.brand], `${order.portions} portions`, order.formula].filter(Boolean).join(' · ')}</p>
      {order.check_status && order.check_status !== 'OK' && <p className="note">Contrôle de la mercuriale : {order.check_status}</p>}
      {issues.map((i) => <p className="err" key={i}>{i} : complète-la dans l'onglet COMPOSITION de la mercuriale.</p>)}
      {comps.filter((c) => c.recipe).map((c) => {
        const rows = needs.filter((n) => n.recipe === c.recipe!.name);
        return (
          <Section key={c.name} title={[c.role ? ROLE_LABEL[c.role] ?? c.role : null, c.name, c.factor !== 1 ? `× ${c.factor.toLocaleString('fr-FR', { maximumFractionDigits: 2 })}` : null].filter(Boolean).join(' · ')}>
            <div className="list">
              {rows.length === 0 && <p className="empty">Fiche vide.</p>}
              {rows.map((n, i) => (
                <div className="row" key={`${n.ingredient}-${i}`} data-need={n.ingredient}>
                  <span className="grow">
                    <span className="t">{n.ingredient}</span>
                    {n.gross > n.net + 1e-9 && <span className="sub">à acheter, pertes comprises : {fmtQty(n.gross, n.unit)}</span>}
                  </span>
                  <span className="end"><strong className="num">{fmtQty(n.net, n.unit)}</strong></span>
                </div>
              ))}
            </div>
          </Section>
        );
      })}
      {money && total != null && <p className="note">Coût matière estimé, pertes comprises : <strong>{fmtEuro(total)}</strong>, soit {fmtEuro(total / order.portions)} par portion.</p>}
      <p className="note">Les quantités sont nettes, à peser pour la production. Celles à acheter comptent les pertes de chaque ingrédient.</p>
      <button type="button" className="btn block" onClick={() => { onClose(); onShopping(order.day); }}>Liste de courses du {fmtDayLong(fromDayKey(order.day))}</button>
    </Sheet>
  );
}

/* ---------- Liste de courses ---------- */
function Shopping({ orders, book, today, day, setDay, ingredients, prices, money }: {
  orders: MercOrder[]; book: Book; today: string; day: string; setDay: (d: string) => void; ingredients: MercIngredient[]; prices: MercPrice[]; money: boolean;
}) {
  const toast = useToast();
  const upcoming = Array.from(new Set(orders.filter((o) => o.day >= today).map((o) => o.day))).sort();
  const current = day || upcoming[0] || today;
  const dayOrders = orders.filter((o) => o.day === current);
  const needs: Need[] = dayOrders.flatMap((o) => orderNeeds(o, components(o, book), book));
  const list = shopping(needs, ingredients, prices);
  const suppliers = Array.from(new Set(list.map((p) => p.supplier)));
  const total = list.every((p) => p.cost != null) ? list.reduce((t, p) => t + (p.cost ?? 0), 0) : null;
  const missing = dayOrders.flatMap((o) => orderIssues(components(o, book), book));

  async function copy() {
    const text = [`Liste de courses, livraison du ${fmtDayLong(fromDayKey(current))}`, '',
      ...suppliers.flatMap((s) => [s, ...list.filter((p) => p.supplier === s).map((p) => `- ${p.ingredient} : ${fmtQty(p.qty, p.unit)}`), ''])].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Liste copiée : colle-la dans un message');
    } catch {
      toast("La copie n'a pas marché sur cet appareil", 'bad');
    }
  }

  return (
    <>
      <div className="acts">
        <Field label="Livraison du">
          <input className="in" id="shop-day" type="date" value={current} onChange={(e) => setDay(e.target.value)} />
        </Field>
      </div>
      {upcoming.length > 1 && (
        <Chips value={current} options={upcoming.slice(0, 8).map((d) => [d, fmtDayLong(fromDayKey(d))] as [string, string])} onChange={setDay} label="Prochaines livraisons" />
      )}
      {dayOrders.length === 0 ? <div className="list"><p className="empty">Aucune commande pour cette livraison.</p></div> : (
        <>
          <Section title="Plats commandés">
            <div className="list">
              {dayOrders.map((o) => (
                <div className="row" key={o.id}>
                  <span className="grow"><span className="t">{o.dish}</span><span className="sub">{SHORT[o.brand]}</span></span>
                  <span className="end"><span className="num">{o.portions} portions</span></span>
                </div>
              ))}
            </div>
            {missing.length > 0 && <p className="err">{missing.join(' · ')} : ces plats manquent dans la liste.</p>}
          </Section>
          {suppliers.map((s) => {
            const items = list.filter((p) => p.supplier === s);
            const sub = items.every((p) => p.cost != null) ? items.reduce((t, p) => t + (p.cost ?? 0), 0) : null;
            return (
              <Section key={s} title={s} right={money && sub != null ? <span className="num">{fmtEuro(sub)}</span> : undefined}>
                <div className="list">
                  {items.map((p) => (
                    <div className="row" key={p.ingredient} data-buy={p.ingredient}>
                      <span className="grow">
                        <span className="t">{p.ingredient}</span>
                        {money && p.price != null && <span className="sub">{fmtEuro(p.price)} le {p.unit === 'pièce' ? 'pièce' : p.unit}</span>}
                      </span>
                      <span className="end">
                        <strong className="num">{fmtQty(p.qty, p.unit)}</strong>
                        {money && <span className="num sub">{fmtEuro(p.cost)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            );
          })}
          {money && total != null && <p className="note">Coût total estimé : <strong>{fmtEuro(total)}</strong> HT.</p>}
          <p className="note">Pertes comprises, comme dans la mercuriale. Les achats à la pièce sont arrondis à la pièce supérieure.</p>
          <button type="button" className="btn" onClick={() => void copy()}><Icon name="copy" />Copier la liste</button>
        </>
      )}
    </>
  );
}

/* ---------- Fiches ---------- */
function Recipes({ recipes, book, money, costs }: { recipes: MercRecipe[]; book: Book; money: boolean; costs: MercCost[] }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<MercRecipe | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const needle = search.trim().toLowerCase();
  const shown = recipes.filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.category.toLowerCase().includes(needle));
  const groups = Array.from(new Set(shown.map((r) => `${r.brand}|${r.category || 'Sans catégorie'}`)));
  const costOf = (r: MercRecipe) => costs.find((c) => c.brand === r.brand && c.name === r.name);
  return (
    <>
      <input className="in" id="merc-search" type="search" placeholder="Chercher une fiche" aria-label="Chercher une fiche" value={search} onChange={(e) => setSearch(e.target.value)} />
      {shown.length === 0 && <div className="list"><p className="empty">Aucune fiche ne correspond.</p></div>}
      {groups.map((g) => {
        const [b, cat] = g.split('|') as [Brand, string];
        return (
          <Section key={g} title={`${SHORT[b]} · ${cat}`}>
            <div className="list">
              {shown.filter((r) => r.brand === b && (r.category || 'Sans catégorie') === cat).map((r) => {
                const c = costOf(r);
                const n = book.linesOf(r).length;
                return (
                  <button type="button" className="row wrap" key={r.name} data-merc-recipe={r.name} onClick={() => setOpen(r)}>
                    <span className="grow">
                      <span className="t">{r.name}</span>
                      <span className="sub">{[`${n} ingrédient${n > 1 ? 's' : ''}`, r.allergens ? `allergènes : ${r.allergens}` : null].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="end">
                      {r.status && r.status !== 'OK' && <span className="pill warn">{r.status}</span>}
                      {money && c?.cost_pct != null && <span className={`pill ${c.cost_pct > 0.35 ? 'warn' : 'ok'}`}>{fmtPct(c.cost_pct)}</span>}
                      <span className="chev"><Icon name="chev" size={18} /></span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        );
      })}
      {open && <RecipeSheet recipe={open} book={book} money={money} cost={costOf(open)} onClose={close} />}
    </>
  );
}

function RecipeSheet({ recipe, book, money, cost, onClose }: { recipe: MercRecipe; book: Book; money: boolean; cost: MercCost | undefined; onClose: () => void }) {
  const [portions, setPortions] = useState(String(recipe.portions > 1 ? recipe.portions : 10));
  const n = Math.max(0, Number(portions.replace(',', '.')) || 0);
  const lines = book.linesOf(recipe);
  return (
    <Sheet title={recipe.name} onClose={onClose}>
      <p className="sub">{[BRAND_LABEL[recipe.brand], recipe.category, recipe.role ? ROLE_LABEL[recipe.role] ?? recipe.role : null, recipe.portion_weight ? `${Math.round(recipe.portion_weight)} g la portion` : null].filter(Boolean).join(' · ')}</p>
      <Field label="Portions à produire">
        <input className="in" id="merc-portions" inputMode="decimal" value={portions} onChange={(e) => setPortions(e.target.value)} />
      </Field>
      <div className="list">
        {lines.length === 0 && <p className="empty">Fiche vide dans la mercuriale.</p>}
        {lines.map((l) => (
          <div className="row" key={l.id}>
            <span className="grow">
              <span className="t">{l.ingredient}</span>
              <span className="sub">{fmtQty(l.quantity / recipe.portions, l.unit)} par portion{l.supplier ? ` · ${l.supplier}` : ''}</span>
            </span>
            <span className="end"><strong className="num">{fmtQty((l.quantity / recipe.portions) * n, l.unit)}</strong></span>
          </div>
        ))}
      </div>
      {recipe.allergens && <p className="note"><strong>Allergènes :</strong> {recipe.allergens}</p>}
      {recipe.label && <p className="note"><strong>Étiquette :</strong> {recipe.label}</p>}
      {money && cost && (
        <p className="note">
          Coût par portion : {fmtEuro(cost.cost_portion)}, {fmtEuro(cost.cost_portion_losses)} pertes comprises
          {cost.sale_price != null ? ` · prix de vente HT ${fmtEuro(cost.sale_price)} · coût matière ${fmtPct(cost.cost_pct)}` : ''}.
        </p>
      )}
      <p className="note">Pour modifier cette fiche : onglet COMPOSITION de la mercuriale. L'appli se met à jour dans les dix minutes.</p>
    </Sheet>
  );
}
