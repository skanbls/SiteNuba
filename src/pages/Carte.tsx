import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Section, Sheet, useToast } from '../components/ui';
import {
  Carte, KIND_LABEL, allergensIn, cap, fmtAmount, fmtUnitPrice, grossOf, isComplete, lineKey, plan, scaleFactor, verdict,
  type MenuCost, type MenuItem, type MenuKind, type MenuLineCost, type Want,
} from '../lib/carte';
import { useMenuCosts, useMenuItems, useMenuLineCosts, useMenuLines, useMercSources, useRecipes } from '../lib/data';
import { fmtEuro, fmtPct, norm } from '../lib/production';
import { useCan } from '../lib/rights';
import { useSession } from '../lib/session';
import { frError } from '../lib/supabase';
import { ALLERGENS, type Recipe } from '../lib/types';
import { ago } from '../lib/time';
import Recipes from './Recipes';

type Tab = MenuKind | 'allergenes' | 'quantites' | 'appli';
const num = (s: string) => Number(s.replace(',', '.').trim());
const fr = (v: number, d = 2) => v.toLocaleString('fr-FR', { maximumFractionDigits: d });
const costKey = (kind: string, name: string) => `${kind}|${name}`;
const over = (c: MenuCost | undefined) => c?.cost_pct != null && c.target_pct != null && c.cost_pct > c.target_pct;

/**
 * Fiches techniques : la carte Nuba, reçue de la mercuriale Nuba (Google Sheets).
 * Cuisine, bar et préparations maison pour l'équipe ; allergènes pour la salle ;
 * quantités pour la mise en place ou un événement. Coûts et marges : accès « fiches techniques ».
 * Sans mercuriale Nuba reliée, la page reste celle des fiches écrites dans l'appli.
 */
export default function CartePage() {
  const can = useCan();
  const money = can('fiches');
  const { profile } = useSession();
  const boss = profile?.role === 'gerant';
  const sources = useMercSources();
  const source = sources.data?.find((s) => s.brand === 'nuba');
  const on = !!source?.synced_at;
  const items = useMenuItems(on);
  const lines = useMenuLines(on);
  const costs = useMenuCosts(on && money);
  const lineCosts = useMenuLineCosts(on && money);
  const recipes = useRecipes();
  const [tab, setTab] = useState<Tab>('plat');

  const carte = useMemo(() => new Carte(items.data ?? [], lines.data ?? []), [items.data, lines.data]);
  const costOf = useMemo(() => new Map((costs.data ?? []).map((c) => [costKey(c.kind, c.name), c])), [costs.data]);
  const lineCostOf = useMemo(() => new Map((lineCosts.data ?? []).map((c) => [lineKey(c), c])), [lineCosts.data]);
  const manual = (recipes.data ?? []).filter((r) => r.active);

  if (sources.isLoading) return <Layout title="Fiches techniques"><Loading /></Layout>;
  if (!on) {
    return (
      <Recipes note={boss && (
        <p className="note">
          Pour voir ici toute la carte (cuisine, bar, préparations maison), relie la mercuriale Nuba dans{' '}
          <Link className="link" to="/reglages">Administration</Link>, rubrique « Mercuriales Google Sheets ».
        </p>
      )} />
    );
  }

  const tabs: [Tab, string][] = [['plat', 'Cuisine'], ['boisson', 'Bar'], ['preparation', 'Maison'], ['allergenes', 'Allergènes'], ['quantites', 'Quantités']];
  if ((recipes.data ?? []).length > 0) tabs.push(['appli', "Fiches de l'appli"]);
  const loading = items.isLoading || lines.isLoading;
  const error = items.error ?? lines.error;

  return (
    <Layout title="Fiches techniques">
      <Chips value={tab} options={tabs} onChange={setTab} label="Rubrique" />
      {tab === 'appli' ? <Recipes embedded /> : loading ? <Loading /> : error ? <div className="list"><p className="empty err">{frError(error)}</p></div> : (
        tab === 'allergenes' ? <Allergens carte={carte} manual={manual} />
          : tab === 'quantites' ? <Quantities carte={carte} money={money} lineCostOf={lineCostOf} />
          : <ItemList key={tab} carte={carte} kind={tab} money={money} costOf={costOf} lineCostOf={lineCostOf} />
      )}
      <p className="note no-print" data-testid="carte-sync">
        Carte reçue de la mercuriale Nuba {source.synced_at ? ago(source.synced_at) : ''}. Les fiches se modifient dans la feuille Google ; l'appli suit toute seule.
        {money && source.sheet_url && <> <a className="link" href={source.sheet_url} target="_blank" rel="noopener noreferrer">Ouvrir la mercuriale</a></>}
      </p>
    </Layout>
  );
}

/* ---------- Cuisine, bar, préparations maison ---------- */
function ItemList({ carte, kind, money, costOf, lineCostOf }: {
  carte: Carte; kind: MenuKind; money: boolean; costOf: Map<string, MenuCost>; lineCostOf: Map<string, MenuLineCost>;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<MenuItem | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const all = carte.of(kind);
  const needle = norm(search);
  const shown = all.filter((i) => !needle || norm(i.name).includes(needle) || norm(i.category).includes(needle));
  const cats = Array.from(new Set(shown.map((i) => i.category || 'Sans catégorie')));
  const prep = kind === 'preparation';

  // Synthèse pour qui voit les coûts, comme l'onglet SYNTHESE CARTE.
  const done = all.filter(isComplete);
  const pcts = done.map((i) => costOf.get(costKey(i.kind, i.name))?.cost_pct).filter((v): v is number => v != null);
  const above = all.filter((i) => over(costOf.get(costKey(i.kind, i.name)))).length;

  return (
    <>
      <input className="in" id="carte-search" type="search" placeholder={prep ? 'Chercher une préparation' : 'Chercher un plat ou une boisson'} aria-label="Chercher une fiche" value={search} onChange={(e) => setSearch(e.target.value)} />
      {money && !prep && all.length > 0 && (
        <div className="stats" data-testid="carte-synthese">
          <div className="stat"><div className="v">{done.length} / {all.length}</div><div className="k">fiches complètes</div></div>
          <div className="stat"><div className="v">{pcts.length ? fmtPct(pcts.reduce((t, v) => t + v, 0) / pcts.length) : '–'}</div><div className="k">coût matière moyen</div></div>
          <div className="stat"><div className="v" style={above ? { color: 'var(--bad)' } : undefined}>{above}</div><div className="k">au-dessus de l'objectif</div></div>
        </div>
      )}
      {shown.length === 0 && <div className="list"><p className="empty">{all.length === 0 ? 'Aucune fiche dans cet onglet de la mercuriale.' : 'Aucune fiche ne correspond.'}</p></div>}
      {cats.map((cat) => (
        <Section key={cat} title={cat}>
          <div className="list">
            {shown.filter((i) => (i.category || 'Sans catégorie') === cat).map((i) => {
              const c = costOf.get(costKey(i.kind, i.name));
              const al = carte.allergens(i);
              const used = prep ? carte.usedIn(i).length : 0;
              const sub = prep
                ? [i.yield_qty ? `donne ${fmtAmount(i.yield_qty, i.yield_unit)}` : 'rendement à saisir', used ? `dans ${used} fiche${used > 1 ? 's' : ''}` : null]
                : [al.length ? `allergènes : ${al.join(', ')}` : 'aucun allergène déclaré'];
              return (
                <button type="button" className="row wrap" key={i.name} data-carte={i.name} onClick={() => setOpen(i)}>
                  <span className="grow">
                    <span className="t">{i.name}</span>
                    <span className="sub">{sub.filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="end">
                    {!isComplete(i) && i.status && <span className="pill warn">{i.status}</span>}
                    {money && c?.cost_pct != null && <span className={`pill ${over(c) ? 'bad' : 'ok'}`}>{fmtPct(c.cost_pct)}</span>}
                    {!prep && i.sale_price != null && <span className="num">{fmtEuro(i.sale_price)}</span>}
                    <span className="chev"><Icon name="chev" size={18} /></span>
                  </span>
                </button>
              );
            })}
          </div>
        </Section>
      ))}
      {open && <FicheSheet carte={carte} item={open} money={money} costOf={costOf} lineCostOf={lineCostOf} onClose={close} />}
    </>
  );
}

/* ---------- Une fiche, à l'échelle ---------- */
function FicheSheet({ carte, item, money, costOf, lineCostOf, onClose }: {
  carte: Carte; item: MenuItem; money: boolean; costOf: Map<string, MenuCost>; lineCostOf: Map<string, MenuLineCost>; onClose: () => void;
}) {
  // Une préparation maison s'ouvre par-dessus la fiche qui l'utilise ; « Retour » y revient.
  const [stack, setStack] = useState<MenuItem[]>([item]);
  const cur = stack[stack.length - 1];
  const push = useCallback((i: MenuItem) => setStack((s) => [...s, i]), []);
  return (
    <Sheet title={cur.name} onClose={onClose}>
      {stack.length > 1 && (
        <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setStack((s) => s.slice(0, -1))}>
          <Icon name="back" size={16} />Retour à {stack[stack.length - 2].name}
        </button>
      )}
      <FicheBody key={costKey(cur.kind, cur.name)} carte={carte} item={cur} money={money} cost={costOf.get(costKey(cur.kind, cur.name))} lineCostOf={lineCostOf} onOpen={push} />
    </Sheet>
  );
}

function FicheBody({ carte, item, money, cost, lineCostOf, onOpen }: {
  carte: Carte; item: MenuItem; money: boolean; cost: MenuCost | undefined; lineCostOf: Map<string, MenuLineCost>; onOpen: (i: MenuItem) => void;
}) {
  const prep = item.kind === 'preparation';
  const base = prep ? item.yield_qty ?? 1 : item.portions;
  const [qty, setQty] = useState(fr(base, 3));
  const n = Math.max(0, num(qty) || 0);
  const f = scaleFactor(item, n) ?? 1;
  const lines = carte.linesOf(item);
  const allergens = carte.allergens(item);
  const check = carte.toCheck(item);
  const used = prep ? carte.usedIn(item) : [];
  const unitLabel = item.yield_unit || 'unités';

  return (
    <>
      <p className="sub">{[KIND_LABEL[item.kind], item.category, !prep && item.sale_price != null ? `${fmtEuro(item.sale_price)} à la carte` : null].filter(Boolean).join(' · ')}</p>
      {!isComplete(item) && item.status && <p><span className="pill warn">Fiche à compléter : {item.status}</span></p>}

      <div className="field">
        <span>Allergènes</span>
        <div className="chips" style={{ flexWrap: 'wrap', overflow: 'visible' }} data-testid="fiche-allergenes">
          {allergens.length === 0 ? <span className="pill">Aucun allergène déclaré</span> : allergens.map((a) => (<span className="pill warn" key={a}>{cap(a)}</span>))}
        </div>
        {carte.uncertain(item) && <small className="err">Fiche incomplète : allergènes à confirmer en cuisine.</small>}
        {check.length > 0 && <small>À vérifier : {check.map((x) => `${x.ingredient} (${x.note})`).join(' · ')}</small>}
      </div>

      <Field
        label={prep ? `Quantité à préparer (${unitLabel})` : 'Portions à préparer'}
        hint={prep
          ? (item.yield_qty ? `La recette donne ${fmtAmount(item.yield_qty, item.yield_unit)}.` : 'Rendement à saisir dans la mercuriale : quantités de la recette entière.')
          : `La fiche est écrite pour ${fr(item.portions)} portion${item.portions > 1 ? 's' : ''}.`}
      >
        <input className="in" id="carte-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
      </Field>

      <div className="list" data-testid="fiche-lignes">
        {lines.length === 0 && <p className="empty">Aucun ingrédient dans la mercuriale.</p>}
        {lines.map((l) => {
          const p = carte.prepOf(l);
          const net = l.quantity != null ? l.quantity * f : null;
          const g = grossOf(l);
          const lc = lineCostOf.get(lineKey(l));
          const al = allergensIn(l.allergens);
          return (
            <div className="row wrap" key={l.position} data-line={l.ingredient}>
              <span className="grow">
                {p ? <button type="button" className="link t" style={{ textAlign: 'left' }} onClick={() => onOpen(p)}>{l.ingredient}</button> : <span className="t">{l.ingredient}</span>}
                <span className="sub">
                  {[p ? 'préparation maison, touche pour la voir' : l.supplier, l.loss > 0 ? `pertes ${fr(l.loss * 100, 1)} %` : null, al.length ? al.map(cap).join(', ') : null,
                    money && lc?.unit_price != null ? fmtUnitPrice(lc.unit_price, l.unit) : null].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="end" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                {net == null ? <span className="pill warn">à saisir</span> : <strong className="num">{fmtAmount(net, l.unit)}</strong>}
                {net != null && g != null && l.loss > 0 && <span className="sub num">à sortir : {fmtAmount(g * f, l.unit)}</span>}
                {money && lc?.cost != null && <span className="sub num">{fmtEuro(lc.cost * f)}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {lines.some((l) => l.loss > 0) && <p className="note">Quantités nettes, dans l'assiette ou le verre. « À sortir » : pertes comprises (épluchage, cuisson, mousse…).</p>}

      {money && cost && (prep ? (
        <div className="stats">
          <div className="stat"><div className="v">{fmtEuro(cost.cost_total != null ? cost.cost_total * f : null)}</div><div className="k">coût de la quantité</div></div>
          <div className="stat"><div className="v">{fmtEuro(cost.cost_unit)}</div><div className="k">par {item.yield_unit || 'unité'}</div></div>
          <div className="stat"><div className="v">{item.yield_qty ? fmtAmount(item.yield_qty, item.yield_unit) : '–'}</div><div className="k">rendement de la recette</div></div>
        </div>
      ) : (
        <>
          <div className="stats" data-testid="fiche-couts">
            <div className="stat"><div className="v">{fmtEuro(cost.cost_portion)}</div><div className="k">coût par portion</div></div>
            <div className="stat"><div className="v" style={over(cost) ? { color: 'var(--bad)' } : undefined}>{fmtPct(cost.cost_pct)}</div><div className="k">coût matière{cost.target_pct != null ? `, objectif ${fmtPct(cost.target_pct)}` : ''}</div></div>
            <div className="stat"><div className="v">{fmtEuro(cost.margin)}</div><div className="k">marge par portion</div></div>
          </div>
          <div className="stats">
            <div className="stat"><div className="v">{fmtEuro(cost.sale_price_ht)}</div><div className="k">prix de vente HT</div></div>
            <div className="stat"><div className="v">{cost.coefficient != null ? fr(cost.coefficient, 2) : '–'}</div><div className="k">coefficient</div></div>
            <div className="stat"><div className="v">{fmtEuro(cost.suggested_price)}</div><div className="k">prix TTC conseillé</div></div>
          </div>
          {cost.cost_portion != null && n > 0 && <p className="note">Coût matière pour {fr(n)} portion{n > 1 ? 's' : ''} : <strong>{fmtEuro(cost.cost_portion * n)}</strong> HT.</p>}
        </>
      ))}

      {used.length > 0 && (
        <div className="field">
          <span>Utilisée dans</span>
          <div className="chips" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
            {used.map((u) => (<button type="button" className="chip" key={costKey(u.kind, u.name)} onClick={() => onOpen(u)}>{u.name}</button>))}
          </div>
        </div>
      )}
      <p className="note">Cette fiche se modifie dans la mercuriale Nuba (Google Sheets) ; l'appli suit toute seule.</p>
    </>
  );
}

/* ---------- Allergènes : ce que la salle peut proposer ---------- */
function Allergens({ carte, manual }: { carte: Carte; manual: Recipe[] }) {
  const [ex, setEx] = useState<string[]>([]);
  const sold = carte.items.filter((i) => i.kind !== 'preparation');
  const toggle = (a: string) => setEx((x) => (x.includes(a) ? x.filter((y) => y !== a) : [...x, a]));
  const judged = sold.map((i) => ({ i, ...verdict(carte, i, ex) }));
  const mine = manual.map((r) => ({ r, found: r.allergens.filter((a) => ex.includes(a)) }));

  const Row = ({ name, sub, pills, kind, tag }: { name: string; sub: string; pills: string[]; kind: string; tag?: string }) => (
    <div className="row wrap" data-allergen-row={name}>
      <div className="grow"><span className="t">{name}</span><span className="sub">{sub}</span></div>
      <div className="end" style={{ flexWrap: 'wrap', justifyContent: 'flex-end', flex: '1 1 160px' }}>
        {tag && <span className="pill warn">{tag}</span>}
        {pills.length === 0 && !tag ? <span className="pill">Aucun déclaré</span> : pills.map((a) => (<span className={`pill ${kind}`} key={a}>{cap(a)}</span>))}
      </div>
    </div>
  );
  const where = (i: MenuItem) => [KIND_LABEL[i.kind], i.category].filter(Boolean).join(' · ');

  return (
    <>
      <div className="field">
        <span>Le client ne peut pas manger</span>
        <div className="chips" role="group" aria-label="Allergènes du client" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
          {ALLERGENS.map((a) => (<button type="button" key={a} className="chip" aria-pressed={ex.includes(a)} onClick={() => toggle(a)}>{cap(a)}</button>))}
        </div>
        {ex.length > 0 && <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setEx([])}>Effacer le choix</button>}
      </div>
      {ex.length === 0 ? (
        (['plat', 'boisson'] as MenuKind[]).map((k) => (
          <Section key={k} title={`Tableau des allergènes · ${KIND_LABEL[k]}`}>
            <div className="list">
              {judged.filter((x) => x.i.kind === k).length === 0 && <p className="empty">Aucune fiche.</p>}
              {judged.filter((x) => x.i.kind === k).map(({ i }) => (
                <Row key={i.name} name={i.name} sub={i.category} pills={carte.allergens(i)} kind="warn" tag={carte.uncertain(i) ? 'À confirmer' : undefined} />
              ))}
            </div>
          </Section>
        ))
      ) : (
        <>
          <Section title="Possible : aucun de ces allergènes déclaré">
            <div className="list" data-testid="allergenes-ok">
              {judged.filter((x) => x.v === 'ok').length === 0 && mine.filter((x) => x.found.length === 0).length === 0 && <p className="empty">Aucune fiche.</p>}
              {judged.filter((x) => x.v === 'ok').map(({ i }) => (<Row key={i.name} name={i.name} sub={where(i)} pills={carte.allergens(i)} kind="" />))}
              {mine.filter((x) => x.found.length === 0).map(({ r }) => (<Row key={r.id} name={r.name} sub={`Fiche de l'appli · ${r.category}`} pills={r.allergens} kind="" />))}
            </div>
          </Section>
          {judged.some((x) => x.v === 'check') && (
            <Section title="À confirmer en cuisine">
              <div className="list" data-testid="allergenes-check">
                {judged.filter((x) => x.v === 'check').map(({ i }) => {
                  const c = carte.toCheck(i);
                  return <Row key={i.name} name={i.name} sub={carte.uncertain(i) ? `${where(i)} · fiche incomplète` : `${where(i)} · à vérifier : ${c.map((x) => x.ingredient).join(', ')}`} pills={carte.allergens(i)} kind="" />;
                })}
              </div>
            </Section>
          )}
          <Section title="À éviter">
            <div className="list" data-testid="allergenes-non">
              {judged.filter((x) => x.v === 'contains').length === 0 && mine.filter((x) => x.found.length > 0).length === 0 && <p className="empty">Aucune fiche.</p>}
              {judged.filter((x) => x.v === 'contains').map(({ i, found }) => (<Row key={i.name} name={i.name} sub={where(i)} pills={found} kind="bad" />))}
              {mine.filter((x) => x.found.length > 0).map(({ r, found }) => (<Row key={r.id} name={r.name} sub={`Fiche de l'appli · ${r.category}`} pills={found} kind="bad" />))}
            </div>
          </Section>
        </>
      )}
      <p className="note">Le tableau suit les fiches de la mercuriale, préparations maison comprises. En cas de doute, demande en cuisine avant de répondre au client.</p>
    </>
  );
}

/* ---------- Quantités pour la mise en place ou un événement ---------- */
const STORE = 'nuba-quantites';
function loadWants(): Want[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '[]') as Want[];
    return Array.isArray(v) ? v.filter((w) => w && typeof w.name === 'string' && typeof w.qty === 'number') : [];
  } catch {
    return [];
  }
}

function Quantities({ carte, money, lineCostOf }: { carte: Carte; money: boolean; lineCostOf: Map<string, MenuLineCost> }) {
  const toast = useToast();
  const [wants, setWants] = useState<Want[]>(loadWants);
  const [pick, setPick] = useState('');
  const [qty, setQty] = useState('10');
  useEffect(() => {
    try {
      localStorage.setItem(STORE, JSON.stringify(wants));
    } catch {
      /* mémoire de l'appareil indisponible : la liste reste le temps de la visite */
    }
  }, [wants]);
  const costs = useMemo(() => (money ? new Map([...lineCostOf].map(([k, c]) => [k, c.cost])) : undefined), [money, lineCostOf]);
  const p = useMemo(() => plan(carte, wants, costs), [carte, wants, costs]);
  const unitOf = (w: Want) => {
    const i = carte.get(w.kind, w.name);
    return w.kind === 'preparation' ? i?.yield_unit || 'unités' : 'portions';
  };

  function add(e: FormEvent) {
    e.preventDefault();
    const [kind, ...rest] = pick.split('|');
    const name = rest.join('|');
    const n = num(qty);
    if (!name || !(n > 0)) return;
    setWants((ws) => {
      const k = ws.findIndex((w) => w.kind === kind && w.name === name);
      if (k === -1) return [...ws, { kind: kind as MenuKind, name, qty: n }];
      return ws.map((w, j) => (j === k ? { ...w, qty: w.qty + n } : w));
    });
    setPick('');
  }

  const suppliers = Array.from(new Set(p.raw.map((r) => r.supplier || 'Sans fournisseur')));
  function text(): string {
    const out = [`Quantités Nuba, ${new Date().toLocaleDateString('fr-FR')}`, '', 'Pour : ' + wants.map((w) => `${fr(w.qty)} ${unitOf(w)} ${w.name}`).join(', ')];
    if (p.preps.length) out.push('', 'Préparations maison à faire :', ...p.preps.map((x) => `- ${x.item.name} : ${fmtAmount(x.qty, x.unit)}`));
    for (const s of suppliers) out.push('', `${s} :`, ...p.raw.filter((r) => (r.supplier || 'Sans fournisseur') === s).map((r) => `- ${r.ingredient} : ${fmtAmount(r.gross, r.unit, r.prefer)}`));
    if (p.issues.length) out.push('', 'À compléter dans la mercuriale :', ...p.issues.map((x) => `- ${x}`));
    return out.join('\n');
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(text());
      toast('Liste copiée');
    } catch {
      toast('Copie impossible sur cet appareil', 'bad');
    }
  }

  return (
    <>
      <p className="note no-print">Choisis les fiches et les quantités, pour la mise en place, un événement ou une privatisation : l'appli additionne les ingrédients, préparations maison comprises.</p>
      <form className="edit-row no-print" onSubmit={add} style={{ flexWrap: 'wrap' }}>
        <select className="in" id="qty-pick" aria-label="Fiche à ajouter" value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: '3 1 200px' }}>
          <option value="">Choisir une fiche…</option>
          {(['plat', 'boisson', 'preparation'] as MenuKind[]).map((k) => (
            <optgroup key={k} label={k === 'preparation' ? 'Préparations maison' : KIND_LABEL[k]}>
              {carte.of(k).map((i) => (<option key={i.name} value={`${k}|${i.name}`}>{i.name}</option>))}
            </optgroup>
          ))}
        </select>
        <input className="in" id="qty-n" inputMode="decimal" aria-label="Quantité" value={qty} onChange={(e) => setQty(e.target.value)} style={{ flex: '1 1 70px' }} />
        <button className="btn pri" disabled={!pick}><Icon name="plus" size={16} />Ajouter</button>
      </form>
      {pick.startsWith('preparation|') && <p className="note no-print">Pour une préparation, la quantité est dans l'unité de son rendement ({carte.get('preparation', pick.slice(12))?.yield_unit || 'unités'}).</p>}

      {wants.length === 0 ? <div className="list"><p className="empty">Aucune fiche choisie.</p></div> : (
        <>
          <Section title="Fiches choisies" right={<button type="button" className="link no-print" onClick={() => setWants([])}>Tout effacer</button>}>
            <div className="list">
              {wants.map((w, k) => (
                <div className="row" key={`${w.kind}|${w.name}`} data-want={w.name}>
                  <span className="grow"><span className="t">{w.name}</span><span className="sub">{KIND_LABEL[w.kind]}</span></span>
                  <span className="end">
                    <input key={w.qty} className="in num" inputMode="decimal" aria-label={`Quantité, ${w.name}`} style={{ width: 80 }} defaultValue={fr(w.qty)}
                      onBlur={(e) => { const v = num(e.target.value); if (v > 0) setWants((ws) => ws.map((x, j) => (j === k ? { ...x, qty: v } : x))); }} />
                    <span className="sub">{unitOf(w)}</span>
                    <button type="button" className="btn sm no no-print" aria-label={`Retirer ${w.name}`} onClick={() => setWants((ws) => ws.filter((_, j) => j !== k))}><Icon name="x" size={16} /></button>
                  </span>
                </div>
              ))}
            </div>
          </Section>

          {p.preps.length > 0 && (
            <Section title="Préparations maison à faire">
              <div className="list">
                {p.preps.map((x) => (
                  <div className="row" key={x.item.name} data-prep={x.item.name}>
                    <span className="grow"><span className="t">{x.item.name}</span>{x.item.yield_qty ? <span className="sub">la recette donne {fmtAmount(x.item.yield_qty, x.item.yield_unit)}</span> : null}</span>
                    <span className="end"><strong className="num">{fmtAmount(x.qty, x.unit)}</strong></span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {suppliers.map((s) => {
            const rows = p.raw.filter((r) => (r.supplier || 'Sans fournisseur') === s);
            const sub = money && rows.every((r) => r.cost != null) ? rows.reduce((t, r) => t + (r.cost ?? 0), 0) : null;
            return (
              <Section key={s} title={s} right={sub != null ? <span className="num">{fmtEuro(sub)}</span> : undefined}>
                <div className="list">
                  {rows.map((r) => (
                    <div className="row" key={`${r.ingredient}|${r.unit}`} data-raw={r.ingredient}>
                      <span className="grow"><span className="t">{r.ingredient}</span>{Math.abs(r.gross - r.net) > 1e-6 && <span className="sub">net {fmtAmount(r.net, r.unit, r.prefer)}</span>}</span>
                      <span className="end">
                        <strong className="num">{fmtAmount(r.gross, r.unit, r.prefer)}</strong>
                        {money && <span className="num sub">{fmtEuro(r.cost)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            );
          })}

          {p.issues.length > 0 && (
            <Section title="À compléter dans la mercuriale">
              <div className="list" data-testid="quantites-manques">
                {p.issues.map((x) => (<div className="row" key={x}><span className="grow sub err">{x}</span></div>))}
              </div>
            </Section>
          )}
          {money && <p className="note">Coût matière estimé : <strong>{fmtEuro(p.cost)}</strong> HT{p.costMissing > 0 ? `, sans ${p.costMissing} ligne${p.costMissing > 1 ? 's' : ''} encore sans prix` : ''}.</p>}
          <p className="note">Quantités à sortir ou à commander, pertes comprises, comme dans la mercuriale.</p>
          <div className="acts no-print">
            <button type="button" className="btn" onClick={() => void copy()}><Icon name="copy" />Copier la liste</button>
            <button type="button" className="btn" onClick={() => window.print()}><Icon name="doc" />Imprimer</button>
          </div>
        </>
      )}
    </>
  );
}
