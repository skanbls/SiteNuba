import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useMercLines, useMercOrders, useMercRecipes, useProcesses } from '../lib/data';
import { BRAND_LABEL, Book, ROLE_LABEL, components, fmtQty, orderNeeds, type Brand, type MercOrder } from '../lib/production';
import {
  dataUrlBlob, deleteProcess, lines, parseImport, parseSteps, photoUrl, processKey, saveProcess, uploadPhoto, type ImportItem, type MercProcess,
} from '../lib/process';
import { useCan } from '../lib/rights';
import { frError } from '../lib/supabase';
import { fmtDayLong, fromDayKey } from '../lib/time';

const isBrand = (b: string | null): b is Brand => b === 'saveurs_nomades' || b === 'comptoir';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Fiche process d'un plat Mijote : photo du dressage, quantités pour la commande, étapes de chaque fiche,
 * dressage et points d'hygiène. Ouverte depuis une commande (?o=id) ou une fiche (?b=marque&d=plat&n=portions).
 * Imprimable : une feuille à poser au poste.
 */
export default function Process() {
  const [params] = useSearchParams();
  const can = useCan();
  const editor = can('fiches');
  const orders = useMercOrders();
  const recipes = useMercRecipes();
  const mlines = useMercLines();
  const procs = useProcesses();
  const book = useMemo(() => new Book(recipes.data ?? [], mlines.data ?? []), [recipes.data, mlines.data]);
  const [edit, setEdit] = useState<{ name: string; whole: boolean } | null>(null);
  const closeEdit = useCallback(() => setEdit(null), []);
  const [portions, setPortions] = useState(params.get('n') ?? '');

  const oid = Number(params.get('o') || 0);
  const order = oid ? (orders.data ?? []).find((o) => o.id === oid) ?? null : null;
  const b = order?.brand ?? params.get('b');
  const dish = order?.dish ?? params.get('d') ?? '';
  const loading = [orders, recipes, mlines, procs].some((q) => q.isLoading);
  if (loading) return <Layout title="Fiche process"><Loading /></Layout>;
  if (!isBrand(b) || !dish) return <Layout title="Fiche process"><div className="list"><p className="empty">Plat introuvable. Ouvre la fiche process depuis une commande de Production.</p></div></Layout>;

  const whole = book.recipe(b, dish);
  const n = order?.portions ?? Math.max(1, Number(portions.replace(',', '.')) || (whole && whole.portions > 1 ? whole.portions : 10));
  const o: MercOrder = order ?? { id: 0, brand: b, position: 0, day: '', formula: '', dish, portions: n, check_status: '', factors: {} };
  const comps = components(o, book);
  const needs = orderNeeds(o, comps, book);
  const procOf = (name: string): MercProcess | undefined => (procs.data ?? []).find((p) => p.brand === b && p.dish_key === processKey(name));
  const dishProc = procOf(dish);
  const parts = comps.filter((c) => c.recipe || procOf(c.name));
  const photo = dishProc?.photo_path || parts.map((c) => procOf(c.name)?.photo_path).find(Boolean) || '';
  const allergens = Array.from(new Set(comps.flatMap((c) => (c.recipe?.allergens ?? '').split(',').map((a) => a.trim())).filter((a) => a && !/^aucun/i.test(a))));
  const unique = (xs: string[]) => Array.from(new Set(xs));
  const dressing = unique([...lines(dishProc?.dressing ?? ''), ...parts.flatMap((c) => (c.name === dish ? [] : lines(procOf(c.name)?.dressing ?? '')))]);
  const haccp = unique([...lines(dishProc?.haccp ?? ''), ...parts.flatMap((c) => (c.name === dish ? [] : lines(procOf(c.name)?.haccp ?? '')))]);
  const combo = comps.length > 1;

  function print() {
    const before = document.title;
    document.title = `Fiche process · ${dish}`;
    window.print();
    document.title = before;
  }

  return (
    <Layout title="Fiche process" right={<button type="button" className="btn sm no-print" onClick={print}><Icon name="doc" size={16} />Imprimer</button>}>
      <div className="process">
        <div>
          <h2 className="process-title">{dish}</h2>
          <p className="sub">{[BRAND_LABEL[b], order ? cap(fmtDayLong(fromDayKey(order.day))) : '', `${n} portions`, order?.formula].filter(Boolean).join(' · ')}</p>
        </div>
        {!order && (
          <div className="no-print">
            <Field label="Portions à produire">
              <input className="in" id="process-portions" inputMode="decimal" value={portions} onChange={(e) => setPortions(e.target.value)} placeholder={String(n)} />
            </Field>
          </div>
        )}

        {photo ? (
          <figure className="process-figure">
            <img className="poster" src={photoUrl(photo)} alt={`Dressage attendu : ${dish}`} />
            <figcaption className="note">Photo du dressage à viser. Seuls les ingrédients de la fiche vont dans le plat : rien d'autre, même pour décorer.</figcaption>
          </figure>
        ) : editor ? (
          <button type="button" className="btn block no-print" onClick={() => setEdit({ name: dish, whole: true })}><Icon name="cam" />Ajouter la photo du dressage</button>
        ) : null}

        {allergens.length > 0 && <p className="process-allergens"><strong>Allergènes :</strong> {allergens.join(', ')}</p>}

        {comps.filter((c) => !c.recipe).map((c) => <p className="err" key={c.name}>Pas de fiche « {c.name} » dans la mercuriale.</p>)}

        {parts.map((c) => {
          const p = procOf(c.name);
          const rows = needs.filter((x) => x.recipe === c.recipe?.name);
          const phases = parseSteps(p?.steps ?? '');
          return (
            <Section key={c.name} title={[c.role ? ROLE_LABEL[c.role] ?? c.role : null, c.name].filter(Boolean).join(' · ')}
              right={editor ? <button type="button" className="link no-print" onClick={() => setEdit({ name: c.name, whole: !combo })}>{p ? 'Modifier' : 'Écrire'}</button> : undefined}>
              {rows.length > 0 && (
                <div className="list process-qty" data-process-qty={c.name}>
                  {rows.map((x, i) => (
                    <div className="row" key={`${x.ingredient}-${i}`}>
                      <span className="grow t">{x.ingredient}</span>
                      <span className="end"><strong className="num">{fmtQty(x.net, x.unit)}</strong></span>
                    </div>
                  ))}
                </div>
              )}
              {phases.length === 0 ? (
                <p className="note">Pas encore d'étapes écrites pour cette fiche.</p>
              ) : phases.map((ph, i) => (
                <div className="process-phase" key={i}>
                  {ph.title && <h3>{ph.title}</h3>}
                  <ol className="steps">{ph.steps.map((st, j) => <li key={j}>{st}</li>)}</ol>
                </div>
              ))}
            </Section>
          );
        })}

        {(dressing.length > 0 || (editor && combo)) && (
          <Section title="Dressage" right={editor && combo ? <button type="button" className="link no-print" onClick={() => setEdit({ name: dish, whole: true })}>{dishProc ? 'Modifier' : 'Écrire'}</button> : undefined}>
            {dressing.length ? <ol className="steps">{dressing.map((d, i) => <li key={i}>{d}</li>)}</ol> : <p className="note">Pas encore de dressage écrit pour ce plat.</p>}
          </Section>
        )}
        {haccp.length > 0 && (
          <Section title="Hygiène et conservation">
            <ul className="steps">{haccp.map((d, i) => <li key={i}>{d}</li>)}</ul>
          </Section>
        )}
        <p className="note">Quantités nettes pour {n} portions, à peser. Elles viennent de la mercuriale ; les étapes et la photo, de l'appli.</p>
        {order && <Link className="btn block no-print" to="/production">Retour à Production</Link>}
      </div>
      {edit && <ProcessEditor brand={b} name={edit.name} whole={edit.whole} current={procOf(edit.name)} onClose={closeEdit} />}
    </Layout>
  );
}

/* ---------- Écrire ou corriger une fiche process (accès « Fiches techniques ») ---------- */
function ProcessEditor({ brand, name, whole, current, onClose }: { brand: Brand; name: string; whole: boolean; current?: MercProcess; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [steps, setSteps] = useState(current?.steps ?? '');
  const [dressing, setDressing] = useState(current?.dressing ?? '');
  const [haccp, setHaccp] = useState(current?.haccp ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : '');
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const photo = file ? await uploadPhoto(brand, file) : current?.photo_path ?? '';
      const problem = await saveProcess({ brand, name, steps, dressing, haccp, photo });
      if (problem) throw new Error(problem);
      await qc.invalidateQueries({ queryKey: ['merc', 'process'] });
      toast('Fiche process enregistrée');
      onClose();
    } catch (x) {
      setErr(x instanceof Error ? x.message : frError(x));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    const problem = await deleteProcess(brand, name);
    setBusy(false);
    if (problem) return setErr(problem);
    await qc.invalidateQueries({ queryKey: ['merc', 'process'] });
    toast('Fiche process supprimée');
    onClose();
  }

  return (
    <Sheet title={name} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Étapes de production" hint="Une étape par ligne. Une ligne qui commence par # est un titre : # Mise en place, # Cuisson, # Refroidissement…">
          <textarea className="in" id="process-steps" value={steps} onChange={(e) => setSteps(e.target.value)} rows={10} maxLength={8000} />
        </Field>
        <Field label="Dressage" hint={whole ? 'Une consigne par ligne : contenant, place de chaque élément, finition.' : 'Pour cet élément du plat sur mesure : où et comment le poser.'}>
          <textarea className="in" id="process-dressing" value={dressing} onChange={(e) => setDressing(e.target.value)} rows={4} maxLength={3000} />
        </Field>
        <Field label="Hygiène et conservation" hint="Températures à cœur, refroidissement, stockage, étiquetage. Une consigne par ligne.">
          <textarea className="in" id="process-haccp" value={haccp} onChange={(e) => setHaccp(e.target.value)} rows={4} maxLength={3000} />
        </Field>
        <Field label="Photo du dressage" hint="Une photo du plat comme il doit partir. Elle est réduite avant l'envoi.">
          <input className="in" id="process-photo" type="file" accept="image/jpeg,image/png,image/webp,image/heic" onChange={pick} />
        </Field>
        {(preview || current?.photo_path) && <img className="poster" src={preview || photoUrl(current?.photo_path ?? '')} alt="Photo du dressage" />}
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer la fiche process'}</button>
        {current && (confirm ? (
          <div className="acts">
            <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
            <button type="button" className="btn no" disabled={busy} onClick={() => void remove()}>Supprimer définitivement</button>
          </div>
        ) : <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Supprimer cette fiche process</button>)}
      </form>
    </Sheet>
  );
}

/* ---------- Importer plusieurs fiches process d'un coup (fichier préparé pour le gérant) ---------- */
export function ProcessImport({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [items, setItems] = useState<ImportItem[] | null>(null);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    setErr('');
    setItems(null);
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      setItems(parseImport(await f.text()));
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  }

  async function run() {
    if (!items) return;
    setBusy(true);
    setDone(0);
    const bad: string[] = [];
    for (const it of items) {
      try {
        const photo = it.photo ? await uploadPhoto(it.brand, dataUrlBlob(it.photo)) : '';
        const problem = await saveProcess({ brand: it.brand, name: it.name, steps: it.steps, dressing: it.dressing, haccp: it.haccp, photo });
        if (problem) throw new Error(problem);
      } catch (x) {
        bad.push(`${it.name} : ${x instanceof Error ? x.message : String(x)}`);
        if (/0023|Envoi refusé/.test(String(x))) break;
      }
      setDone((d) => d + 1);
    }
    setBusy(false);
    setFailed(bad);
    await qc.invalidateQueries({ queryKey: ['merc', 'process'] });
    if (!bad.length) {
      toast(`${items.length} fiches process importées`);
      onClose();
    }
  }

  return (
    <Sheet title="Importer des fiches process" onClose={onClose}>
      <div className="form">
        <p className="note">Choisis le fichier de fiches process (.json) qu'on t'a préparé. Une fiche déjà présente pour le même plat est remplacée.</p>
        <Field label="Fichier"><input className="in" id="process-import" type="file" accept="application/json,.json" onChange={(e) => void pick(e)} /></Field>
        {items && <p className="sub" data-testid="process-import-count">{items.length} fiche{items.length > 1 ? 's' : ''} dans le fichier, dont {items.filter((i) => i.photo).length} avec photo.</p>}
        {busy && <p className="sub" role="status">Import en cours : {done} sur {items?.length ?? 0}…</p>}
        {failed.length > 0 && <div className="err" role="alert">{failed.slice(0, 6).map((f) => <p key={f}>{f}</p>)}</div>}
        {err && <p className="err" role="alert">{err}</p>}
        <button type="button" className="btn pri block" disabled={!items || busy} onClick={() => void run()}>{busy ? <Spinner /> : 'Importer'}</button>
      </div>
    </Sheet>
  );
}
