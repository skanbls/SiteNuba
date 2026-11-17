import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { ChecklistBoard } from '../components/ChecklistBoard';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useColdUnits, useOil, useReadings, useRefresh, useTeam, useTodayTasks, useTrace } from '../lib/data';
import { useMe } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { addDays, dayKey, fmtDate, fmtDateShort, fmtTime, fromDayKey, toCsv } from '../lib/time';
import { fullName, type ColdUnit, type OilLog, type Profile, type TempReading, type TraceItem } from '../lib/types';
import { useCan } from '../lib/rights';

type Tab = 'temp' | 'net' | 'tra' | 'oil';
const TABS: [Tab, string][] = [['temp', 'Températures'], ['net', 'Nettoyage'], ['tra', 'Dates limites'], ['oil', 'Friteuse']];
const POLAR_LIMIT = 25;

const deg = (v: number) => `${v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).replace('-', '−')} °C`;
const plain = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }).replace('-', '−');
/** Cible lisible : « de 0 à 4 °C », ou « −18 °C ou moins » pour le froid négatif. */
const target = (u: Pick<ColdUnit, 'min_temp' | 'max_temp'>) => (u.min_temp <= -25 ? `${plain(u.max_temp)} °C ou moins` : `de ${plain(u.min_temp)} à ${plain(u.max_temp)} °C`);
const num = (s: string) => Number(s.replace(',', '.').replace('−', '-'));

/** Hygiène : températures, plan de nettoyage, dates limites, huile de friture. */
export default function Hygiene() {
  const me = useMe();
  const can = useCan();
  const editor = can('hygiene');
  const [tab, setTab] = useState<Tab>('temp');
  const tasks = useTodayTasks();
  const day = tasks.data?.day ?? dayKey(new Date());
  const team = useTeam();
  const who = useMemo(() => new Map((team.data ?? []).map((p) => [p.id, p])), [team.data]);

  return (
    <Layout title="Hygiène">
      <Chips value={tab} options={TABS} onChange={setTab} label="Rubrique" />
      {tasks.error ? <div className="list"><p className="empty err">{frError(tasks.error)}</p></div> : (
        <>
          {tab === 'temp' && <Temps editor={editor} day={day} slot={tasks.data?.slot ?? 'matin'} who={who} />}
          {tab === 'net' && (
            <>
              <ChecklistBoard kind="nettoyage" />
              <p className="note">Le plan de nettoyage se coche comme une checklist. Chaque case garde le nom et l'heure, à présenter lors d'un contrôle.</p>
            </>
          )}
          {tab === 'tra' && <Trace me={me} day={day} />}
          {tab === 'oil' && <Oil me={me} who={who} />}
        </>
      )}
    </Layout>
  );
}

/* ---------- Températures ---------- */
function Temps({ editor, day, slot, who }: { editor: boolean; day: string; slot: 'matin' | 'soir'; who: Map<string, Profile> }) {
  const toast = useToast();
  const refresh = useRefresh();
  const units = useColdUnits();
  const readings = useReadings(day);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [edit, setEdit] = useState<ColdUnit | 'new' | null>(null);
  const closeEdit = useCallback(() => setEdit(null), []);
  const shown = (units.data ?? []).filter((u) => u.active || editor);

  async function record(u: ColdUnit) {
    const v = num(values[u.id] ?? '');
    if ((values[u.id] ?? '').trim() === '' || Number.isNaN(v)) return toast("Saisis d'abord la température.", 'bad');
    setBusy(u.id);
    const { data, error } = await supabase.rpc('record_temp', { p_unit: u.id, p_value: v });
    setBusy('');
    if (error) return toast(frError(error), 'bad');
    const r = data as { ok: boolean; out_of_range?: boolean; error?: string };
    if (!r.ok) return toast(r.error === 'value' ? 'Cette température est impossible. Vérifie la saisie.' : "Cette enceinte n'existe plus.", 'bad');
    setValues((s) => ({ ...s, [u.id]: '' }));
    await refresh('readings', 'tasks');
    if (r.out_of_range) toast("Hors limite : note l'action corrective.", 'bad');
    else toast('Relevé enregistré');
  }

  async function fix(r: TempReading) {
    const text = (notes[r.id] ?? '').trim();
    if (!text) return toast("Décris l'action corrective.", 'bad');
    setBusy(r.id);
    const { error } = await supabase.rpc('note_corrective', { p_reading: r.id, p_text: text });
    setBusy('');
    if (error) return toast(frError(error), 'bad');
    await refresh('readings', 'tasks');
    toast('Action corrective enregistrée');
  }

  if (units.isLoading || readings.isLoading) return <Loading />;
  if (units.error) return <div className="list"><p className="empty err">{frError(units.error)}</p></div>;

  return (
    <Section title={`Relevés du ${fmtDateShort(day)}`}>
      <div className="list">
        {shown.length === 0 && <p className="empty">Aucune enceinte froide.{editor ? ' Ajoute la première ci-dessous.' : ''}</p>}
        {shown.map((u) => {
          const mine = (readings.data ?? []).filter((r) => r.unit_id === u.id);
          const done = mine.some((r) => u.readings_per_day === 1 || r.slot === slot);
          return (
            <div className="row wrap" key={u.id} data-unit={u.name}>
              <div className="grow" style={{ flexBasis: 220 }}>
                <span className="t">{u.name}{!u.active && <span className="pill" style={{ marginLeft: 8 }}>Retirée</span>}</span>
                <span className="sub">Cible : {target(u)}{u.readings_per_day === 1 ? ' · un relevé par jour' : ''}</span>
                {mine.map((r) => (
                  <span className="sub" key={r.id}>
                    {r.slot === 'matin' ? 'Matin' : 'Soir'} : <b className="num">{deg(r.value)}</b> à {fmtTime(r.taken_at)}, {who.get(r.taken_by ?? '')?.first_name ?? 'ancien membre'}{' '}
                    <span className={`pill ${!r.out_of_range ? 'ok' : r.corrective ? 'warn' : 'bad'}`}>{!r.out_of_range ? 'Conforme' : r.corrective ? 'Corrigé' : 'Hors limite'}</span>
                    {r.corrective && <span className="sub" style={{ display: 'block' }}>Action : {r.corrective}</span>}
                  </span>
                ))}
              </div>
              {u.active && (
                <div className="end">
                  {!done && <span className="pill warn">À relever</span>}
                  <input className="in temp num" inputMode="decimal" placeholder="°C" aria-label={`Température de ${u.name}`} value={values[u.id] ?? ''}
                    onChange={(e) => setValues((s) => ({ ...s, [u.id]: e.target.value }))} />
                  <button type="button" className="btn sm pri" disabled={busy === u.id} onClick={() => void record(u)}>Relever</button>
                  {editor && <button type="button" className="btn sm" onClick={() => setEdit(u)} aria-label={`Modifier ${u.name}`}><Icon name="cog" size={16} /></button>}
                </div>
              )}
              {!u.active && editor && <div className="end"><button type="button" className="btn sm" onClick={() => setEdit(u)}>Modifier</button></div>}
              {mine.filter((r) => r.out_of_range && !r.corrective).map((r) => (
                <div className="end" style={{ flex: '1 1 100%' }} key={r.id}>
                  <input className="in grow" placeholder="Action corrective (ex. porte refermée, recontrôle dans 30 min)" aria-label={`Action corrective pour ${u.name}`} value={notes[r.id] ?? ''}
                    onChange={(e) => setNotes((s) => ({ ...s, [r.id]: e.target.value }))} maxLength={200} />
                  <button type="button" className="btn sm pri" disabled={busy === r.id} onClick={() => void fix(r)}>Noter</button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <p className="note">Un relevé le matin et un le soir par enceinte, sauf indication contraire. Hors de la cible, l'appli demande l'action corrective et le signale sur l'accueil.</p>
      {editor && (
        <div className="acts">
          <button type="button" className="btn" onClick={() => setEdit('new')}><Icon name="plus" />Ajouter une enceinte</button>
          <ExportButton who={who} />
        </div>
      )}
      {edit && <UnitSheet unit={edit} onClose={closeEdit} />}
    </Section>
  );
}

function UnitSheet({ unit, onClose }: { unit: ColdUnit | 'new'; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = unit === 'new' ? null : unit;
  const [name, setName] = useState(old?.name ?? '');
  const [min, setMin] = useState(String(old?.min_temp ?? 0));
  const [max, setMax] = useState(String(old?.max_temp ?? 4));
  const [per, setPer] = useState(String(old?.readings_per_day ?? 2));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(/cold_units_range/.test(error.message) ? 'La température maximale doit dépasser la minimale.' : frError(error));
    await refresh('units', 'tasks');
    toast(done);
    onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const a = num(min), b = num(max);
    if (Number.isNaN(a) || Number.isNaN(b)) return setErr('Indique les deux températures.');
    const row = { name: name.trim(), min_temp: a, max_temp: b, readings_per_day: Number(per) };
    void (old ? run(() => supabase.from('cold_units').update(row).eq('id', old.id), 'Enceinte enregistrée') : run(() => supabase.from('cold_units').insert(row), 'Enceinte ajoutée'));
  }

  return (
    <Sheet title={old ? old.name : 'Ajouter une enceinte'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Nom">
          <input className="in" id="unit-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Frigo bar, congélateur…" required maxLength={60} />
        </Field>
        <div className="two">
          <Field label="Température minimale (°C)">
            <input className="in" id="unit-min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} required />
          </Field>
          <Field label="Température maximale (°C)">
            <input className="in" id="unit-max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} required />
          </Field>
        </div>
        <Field label="Relevés par jour" hint="Froid positif : 0 à 4 °C. Congélateur : −18 °C ou moins.">
          <select className="in" id="unit-per" value={per} onChange={(e) => setPer(e.target.value)}>
            <option value="2">Deux : matin et soir</option>
            <option value="1">Un seul</option>
          </select>
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && (
          <button type="button" className="btn block" disabled={busy}
            onClick={() => void run(() => supabase.from('cold_units').update({ active: !old.active }).eq('id', old.id), old.active ? 'Enceinte retirée' : 'Enceinte remise en service')}>
            {old.active ? 'Retirer cette enceinte' : 'Remettre en service'}
          </button>
        )}
        {old && <p className="note">Retirer une enceinte conserve ses anciens relevés.</p>}
      </form>
    </Sheet>
  );
}

/* ---------- Export pour un contrôle (gérant) ---------- */
function ExportButton({ who }: { who: Map<string, Profile> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const name = (id: string | null) => (id ? fullName(who.get(id)) : '');

  async function run() {
    setBusy(true);
    const since = dayKey(addDays(new Date(), -31));
    const sinceIso = addDays(new Date(), -31).toISOString();
    const [temps, ticks, trace, oil] = await Promise.all([
      supabase.from('temp_readings').select('*, cold_units(name)').gte('day', since).order('taken_at'),
      supabase.from('checklist_ticks').select('period, done_at, done_by, checklist_items(label, checklists(name, kind))').gte('period', since).order('done_at'),
      supabase.from('trace_items').select('*').gte('created_at', sinceIso).order('made_on'),
      supabase.from('oil_logs').select('*').gte('done_at', sinceIso).order('done_at'),
    ]);
    setBusy(false);
    const failed = [temps, ticks, trace, oil].find((r) => r.error);
    if (failed?.error) return toast(frError(failed.error), 'bad');

    const rows: (string | number)[][] = [['RELEVÉS DE TEMPÉRATURE'], ['Jour', 'Moment', 'Enceinte', 'Température (°C)', 'Conforme', 'Action corrective', 'Relevé par', 'Heure']];
    for (const r of (temps.data ?? []) as (TempReading & { cold_units: { name: string } | null })[]) {
      rows.push([fmtDate(fromDayKey(r.day)), r.slot, r.cold_units?.name ?? '', r.value, r.out_of_range ? 'Non' : 'Oui', r.corrective, name(r.taken_by), fmtTime(r.taken_at)]);
    }
    rows.push([], ['PLAN DE NETTOYAGE'], ['Période', 'Liste', 'Tâche', 'Fait par', 'Le', 'À']);
    type Tick = { period: string; done_at: string; done_by: string | null; checklist_items: { label: string; checklists: { name: string; kind: string } | null } | null };
    for (const t of (ticks.data ?? []) as unknown as Tick[]) {
      if (t.checklist_items?.checklists?.kind !== 'nettoyage') continue;
      rows.push([fmtDate(fromDayKey(t.period)), t.checklist_items.checklists.name, t.checklist_items.label, name(t.done_by), fmtDate(t.done_at), fmtTime(t.done_at)]);
    }
    rows.push([], ['PRÉPARATIONS ET PRODUITS ENTAMÉS'], ['Produit', 'Type', 'Fabriqué ou ouvert le', 'À utiliser avant le', 'Sorti le', 'Motif', 'Note']);
    for (const t of (trace.data ?? []) as TraceItem[]) {
      rows.push([t.name, t.kind === 'ouverture' ? 'Produit entamé' : 'Préparation', fmtDate(fromDayKey(t.made_on)), fmtDate(fromDayKey(t.use_by)), t.closed_at ? fmtDate(t.closed_at) : '', t.closed_reason === 'jete' ? 'Jeté' : t.closed_reason === 'utilise' ? 'Terminé' : '', t.note]);
    }
    rows.push([], ['HUILE DE FRITURE'], ['Le', 'Action', 'Composés polaires (%)', 'Par', 'Note']);
    for (const o of (oil.data ?? []) as OilLog[]) {
      rows.push([fmtDate(o.done_at), o.action === 'test' ? 'Test' : 'Changement', o.polar_pct ?? '', name(o.done_by), o.note]);
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    a.download = `hygiene-${since}-au-${dayKey(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  return <button type="button" className="btn" disabled={busy} onClick={() => void run()}><Icon name="down" />{busy ? 'Préparation…' : "Exporter le dossier d'hygiène (30 jours)"}</button>;
}

/* ---------- Dates limites : préparations et produits entamés ---------- */
function Trace({ me, day }: { me: Profile; day: string }) {
  const toast = useToast();
  const refresh = useRefresh();
  const items = useTrace();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TraceItem['kind']>('preparation');
  const [made, setMade] = useState(day);
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const plus = (n: number) => setUntil(dayKey(addDays(fromDayKey(made || day), n)));

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!until) return setErr('Indique la date limite, ou touche une durée.');
    if (until < made) return setErr('La date limite est avant la fabrication.');
    setBusy(true);
    setErr('');
    const { error } = await supabase.from('trace_items').insert({ name: name.trim(), kind, made_on: made, use_by: until, note: note.trim(), created_by: me.id });
    setBusy(false);
    if (error) return setErr(frError(error));
    setName('');
    setNote('');
    setUntil('');
    await refresh('trace', 'tasks');
    toast('Étiquette enregistrée');
  }

  async function close(t: TraceItem, reason: 'utilise' | 'jete') {
    setBusy(true);
    const { error } = await supabase.rpc('close_trace', { p_id: t.id, p_reason: reason });
    setBusy(false);
    if (error) return toast(frError(error), 'bad');
    await refresh('trace', 'tasks');
    toast(reason === 'jete' ? `${t.name} : jeté` : `${t.name} : terminé`);
  }

  const state = (t: TraceItem): [string, string] => {
    if (t.use_by < day) return ['bad', 'Dépassée'];
    if (t.use_by === day) return ['warn', "À utiliser aujourd'hui"];
    const n = Math.round((fromDayKey(t.use_by).getTime() - fromDayKey(day).getTime()) / 86_400_000);
    return ['ok', `Encore ${n} j`];
  };

  return (
    <div className="cols">
      <Section title="En cours">
        {items.isLoading ? <Loading /> : (
          <div className="list">
            {(items.data ?? []).length === 0 && <p className="empty">Aucune préparation ni produit entamé à suivre.</p>}
            {(items.data ?? []).map((t) => {
              const [cls, label] = state(t);
              return (
                <div className="row wrap" key={t.id} data-trace={t.name}>
                  <div className="grow">
                    <span className="t">{t.name}</span>
                    <span className="sub">{t.kind === 'ouverture' ? 'Entamé' : 'Fabriqué'} le {fmtDateShort(t.made_on)} · à utiliser avant le {fmtDateShort(t.use_by)}</span>
                    {t.note && <span className="sub">{t.note}</span>}
                  </div>
                  <div className="end">
                    <span className={`pill ${cls}`}>{label}</span>
                    <button type="button" className="btn sm" disabled={busy} onClick={() => void close(t, 'utilise')}>Terminé</button>
                    <button type="button" className="btn sm no" disabled={busy} onClick={() => void close(t, 'jete')}>Jeter</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Nouvelle étiquette">
        <form className="form" onSubmit={add}>
          <Field label="Produit">
            <input className="in" id="trace-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sauce maison, jambon entamé…" required maxLength={80} />
          </Field>
          <div className="two">
            <Field label="Type">
              <select className="in" id="trace-kind" value={kind} onChange={(e) => setKind(e.target.value as TraceItem['kind'])}>
                <option value="preparation">Préparation maison</option>
                <option value="ouverture">Produit entamé</option>
              </select>
            </Field>
            <Field label={kind === 'ouverture' ? 'Entamé le' : 'Fabriqué le'}>
              <input className="in" id="trace-made" type="date" value={made} onChange={(e) => setMade(e.target.value)} required />
            </Field>
          </div>
          <Field label="À utiliser avant le">
            <input className="in" id="trace-until" type="date" value={until} min={made} onChange={(e) => setUntil(e.target.value)} />
          </Field>
          <div className="chips" role="group" aria-label="Durée de conservation">
            {[1, 2, 3, 5, 7].map((n) => (<button type="button" className="chip" key={n} onClick={() => plus(n)}>+{n} j</button>))}
          </div>
          <Field label="Note">
            <input className="in" id="trace-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Facultatif : numéro de lot, allergène…" />
          </Field>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : "Enregistrer l'étiquette"}</button>
          <p className="note">Les durées de conservation sont celles de ton plan de maîtrise sanitaire : l'appli calcule la date, elle ne décide pas de la durée.</p>
        </form>
      </Section>
    </div>
  );
}

/* ---------- Huile de friture ---------- */
function Oil({ me, who }: { me: Profile; who: Map<string, Profile> }) {
  const toast = useToast();
  const refresh = useRefresh();
  const logs = useOil();
  const [pct, setPct] = useState('');
  const [busy, setBusy] = useState(false);
  const list = logs.data ?? [];
  const change = list.find((l) => l.action === 'changement');
  const test = list.find((l) => l.action === 'test' && (!change || l.done_at > change.done_at));
  const days = change ? Math.floor((Date.now() - new Date(change.done_at).getTime()) / 86_400_000) : null;
  const verdict = (p: number): [string, string] => (p > POLAR_LIMIT ? ['bad', 'À changer'] : p >= 20 ? ['warn', 'À surveiller'] : ['ok', 'Conforme']);

  async function add(row: { action: 'test' | 'changement'; polar_pct?: number }, done: string) {
    setBusy(true);
    const { error } = await supabase.from('oil_logs').insert({ ...row, done_by: me.id });
    setBusy(false);
    if (error) return toast(frError(error), 'bad');
    setPct('');
    await refresh('oil');
    toast(done);
  }

  function addTest(e: FormEvent) {
    e.preventDefault();
    const v = num(pct);
    if (pct.trim() === '' || Number.isNaN(v) || v < 0 || v > 100) return toast('Indique un pourcentage entre 0 et 100.', 'bad');
    void add({ action: 'test', polar_pct: v }, v > POLAR_LIMIT ? `Test noté : au-dessus de ${POLAR_LIMIT} %, l'huile est à changer` : 'Test noté');
  }

  if (logs.isLoading) return <Loading />;
  if (logs.error) return <div className="list"><p className="empty err">{frError(logs.error)}</p></div>;

  return (
    <div className="cols">
      <div className="stack">
        <Section title="État de l'huile">
          <div className="list">
            <div className="row">
              <div className="grow">
                <span className="t">{change ? (days === 0 ? "Huile changée aujourd'hui" : `Huile changée il y a ${days} jour${days! > 1 ? 's' : ''}`) : 'Aucun changement noté'}</span>
                {change && <span className="sub">Le {fmtDateShort(new Date(change.done_at))}, par {who.get(change.done_by ?? '')?.first_name ?? 'un ancien membre'}</span>}
              </div>
            </div>
            <div className="row">
              <div className="grow">
                <span className="t">{test ? `Dernier test : ${String(test.polar_pct).replace('.', ',')} % de composés polaires` : 'Aucun test depuis le dernier changement'}</span>
                <span className="sub">Limite : {POLAR_LIMIT} %. Au-delà, l'huile doit être changée.</span>
              </div>
              {test && test.polar_pct !== null && <span className={`pill ${verdict(test.polar_pct)[0]}`}>{verdict(test.polar_pct)[1]}</span>}
            </div>
          </div>
        </Section>
        <form className="form" onSubmit={addTest}>
          <Field label="Résultat du test (% de composés polaires)">
            <input className="in" id="oil-pct" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="18" />
          </Field>
          <div className="acts">
            <button className="btn pri" disabled={busy}>Noter le test</button>
            <button type="button" className="btn" disabled={busy} onClick={() => void add({ action: 'changement' }, "Changement d'huile noté")}>Huile changée</button>
          </div>
        </form>
      </div>

      <Section title="Historique">
        <div className="list">
          {list.length === 0 && <p className="empty">Rien de noté pour l'instant.</p>}
          {list.map((l) => (
            <div className="row" key={l.id}>
              <div className="grow">
                <span className="t">{l.action === 'test' ? `Test : ${String(l.polar_pct).replace('.', ',')} %` : "Changement d'huile"}</span>
                <span className="sub">{fmtDateShort(new Date(l.done_at))} à {fmtTime(l.done_at)}, {who.get(l.done_by ?? '')?.first_name ?? 'ancien membre'}</span>
              </div>
              {l.action === 'test' && l.polar_pct !== null && <span className={`pill ${verdict(l.polar_pct)[0]}`}>{verdict(l.polar_pct)[1]}</span>}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
