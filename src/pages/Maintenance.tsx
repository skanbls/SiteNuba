import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useDeadlines, useIssues, useRefresh, useTeam, useTodayTasks } from '../lib/data';
import { useMe } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { dayKey, fmtDateShort, fmtTime, fromDayKey } from '../lib/time';
import { DEADLINE_LABEL, fullName, type Deadline, type DeadlineCategory, type Issue, type Profile } from '../lib/types';

type Tab = 'pannes' | 'echeances';
const REPEATS: [string, string][] = [['', 'Une seule fois'], ['1', 'Tous les mois'], ['3', 'Tous les 3 mois'], ['6', 'Tous les 6 mois'], ['12', 'Tous les ans'], ['24', 'Tous les 2 ans'], ['36', 'Tous les 3 ans'], ['60', 'Tous les 5 ans'], ['120', 'Tous les 10 ans']];
const IDEAS: [string, DeadlineCategory, string][] = [['Extincteurs : vérification', 'controle', '12'], ['Hotte : dégraissage', 'controle', '12'], ['Installation électrique : contrôle', 'controle', '12'], ['Installation de gaz : contrôle', 'controle', '12'], ['Dératisation', 'contrat', '3'], ['Assurance : échéance', 'contrat', '12']];

/** Maintenance : pannes signalées par l'équipe, et échéances suivies par le gérant. */
export default function Maintenance() {
  const me = useMe();
  const gerant = me.role === 'gerant';
  const [tab, setTab] = useState<Tab>('pannes');
  const team = useTeam();
  const who = useMemo(() => new Map((team.data ?? []).map((p) => [p.id, p])), [team.data]);
  return (
    <Layout title="Maintenance">
      {gerant && <Chips value={tab} options={[['pannes', 'Pannes'], ['echeances', 'Échéances']]} onChange={setTab} label="Rubrique" />}
      {tab === 'pannes' || !gerant ? <Issues gerant={gerant} who={who} /> : <Deadlines who={who} team={(team.data ?? []).filter((p) => p.active)} />}
    </Layout>
  );
}

/* ---------- Pannes ---------- */
function Issues({ gerant, who }: { gerant: boolean; who: Map<string, Profile> }) {
  const issues = useIssues();
  const [open, setOpen] = useState<Issue | 'new' | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const all = issues.data ?? [];
  const current = all.filter((i) => i.status !== 'done').sort((a, b) => Number(b.urgent) - Number(a.urgent));
  const fixed = all.filter((i) => i.status === 'done').slice(0, 10);

  const row = (i: Issue) => (
    <button type="button" className="row wrap" key={i.id} data-issue={i.title} onClick={() => setOpen(i)}>
      <span className="grow">
        <span className="t">{i.title}</span>
        <span className="sub">{[i.place, `signalée par ${who.get(i.reported_by ?? '')?.first_name ?? 'un ancien membre'} le ${fmtDateShort(new Date(i.reported_at))}`].filter(Boolean).join(' · ')}</span>
        {i.resolution && <span className="sub">{i.resolution}</span>}
      </span>
      <span className="end">
        {i.status === 'done' ? <span className="pill ok">Réparée</span> : (
          <>
            {i.urgent && <span className="pill bad">Urgent</span>}
            <span className={`pill ${i.status === 'doing' ? 'info' : 'warn'}`}>{i.status === 'doing' ? 'En cours' : 'À traiter'}</span>
          </>
        )}
        <span className="chev"><Icon name="chev" size={18} /></span>
      </span>
    </button>
  );

  if (issues.isLoading) return <Loading />;
  if (issues.error) return <div className="list"><p className="empty err">{frError(issues.error)}</p></div>;
  return (
    <>
      <button type="button" className="btn pri block" onClick={() => setOpen('new')}><Icon name="alert" />Signaler une panne</button>
      <Section title="À traiter">
        <div className="list">
          {current.length === 0 && <p className="empty">Aucune panne en cours.</p>}
          {current.map(row)}
        </div>
      </Section>
      {fixed.length > 0 && <Section title="Réparées récemment"><div className="list">{fixed.map(row)}</div></Section>}
      {open && <IssueSheet issue={open} gerant={gerant} onClose={close} />}
    </>
  );
}

function IssueSheet({ issue, gerant, onClose }: { issue: Issue | 'new'; gerant: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = issue === 'new' ? null : issue;
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState('');
  const [details, setDetails] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [resolution, setResolution] = useState(old?.resolution ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('issues', 'tasks');
    toast(done);
    onClose();
  }

  if (!old)
    return (
      <Sheet title="Signaler une panne" onClose={onClose}>
        <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => supabase.rpc('report_issue', { p_title: title, p_place: place, p_details: details, p_urgent: urgent }), 'Panne signalée'); }}>
          <Field label="Qu'est-ce qui ne marche pas ?"><input className="in" id="iss-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Frigo du bar qui goutte" required maxLength={100} /></Field>
          <Field label="Où ?"><input className="in" id="iss-place" value={place} onChange={(e) => setPlace(e.target.value)} placeholder="Bar, cuisine, terrasse…" maxLength={60} /></Field>
          <Field label="Précisions"><textarea className="in" id="iss-details" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} /></Field>
          <label className="row" style={{ padding: 0, gap: 10 }}>
            <input id="iss-urgent" type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span className="grow"><span className="t">Urgent</span><span className="sub">Gêne le service, ou présente un danger.</span></span>
          </label>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Signaler'}</button>
        </form>
      </Sheet>
    );

  const setStatus = (status: Issue['status'], done: string) => run(() => supabase.rpc('set_issue_status', { p_id: old.id, p_status: status, p_resolution: resolution }), done);
  return (
    <Sheet title={old.title} onClose={onClose}>
      <div className="list">
        {old.place && <div className="row"><div className="grow"><span className="sub">Où</span><span className="t">{old.place}</span></div></div>}
        {old.details && <div className="row"><div className="grow"><span className="sub">Précisions</span><span className="t" style={{ fontWeight: 500, whiteSpace: 'pre-wrap' }}>{old.details}</span></div></div>}
        <div className="row"><div className="grow"><span className="sub">Signalée</span><span className="t">le {fmtDateShort(new Date(old.reported_at))} à {fmtTime(old.reported_at)}</span></div>{old.urgent && old.status !== 'done' && <span className="pill bad">Urgent</span>}</div>
        {old.closed_at && <div className="row"><div className="grow"><span className="sub">Réparée</span><span className="t">le {fmtDateShort(new Date(old.closed_at))}</span></div></div>}
      </div>
      <Field label="Suivi" hint="Ce qui a été fait : dépanneur appelé, pièce commandée, réparé par…">
        <input className="in" id="iss-resolution" value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={300} />
      </Field>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="acts">
        {old.status !== 'doing' && old.status !== 'done' && <button type="button" className="btn" disabled={busy} onClick={() => void setStatus('doing', 'Panne en cours de réparation')}>En cours de réparation</button>}
        {old.status !== 'done' && <button type="button" className="btn pri" disabled={busy} onClick={() => void setStatus('done', 'Panne réparée')}>Réparée</button>}
        {old.status === 'done' && <button type="button" className="btn" disabled={busy} onClick={() => void setStatus('open', 'Panne rouverte')}>Rouvrir</button>}
      </div>
      {gerant && <button type="button" className="btn no block" disabled={busy} onClick={() => void run(() => supabase.from('issues').delete().eq('id', old.id), 'Panne supprimée')}>Supprimer</button>}
    </Sheet>
  );
}

/* ---------- Échéances (gérant) ---------- */
function Deadlines({ who, team }: { who: Map<string, Profile>; team: Profile[] }) {
  const toast = useToast();
  const refresh = useRefresh();
  const tasks = useTodayTasks();
  const today = tasks.data?.day ?? dayKey(new Date());
  const deadlines = useDeadlines(true);
  const [edit, setEdit] = useState<Deadline | { title: string; category: DeadlineCategory; repeat: string } | null>(null);
  const [busy, setBusy] = useState('');
  const close = useCallback(() => setEdit(null), []);
  const all = deadlines.data ?? [];

  async function complete(d: Deadline) {
    setBusy(d.id);
    const { error } = await supabase.rpc('complete_deadline', { p_id: d.id, p_done_on: null, p_note: '' });
    setBusy('');
    if (error) return toast(frError(error), 'bad');
    await refresh('deadlines', 'tasks');
    toast(d.repeat_months ? `${d.title} : fait, prochaine échéance reportée` : `${d.title} : fait et classé`);
  }

  const state = (d: Deadline): [string, string] => {
    const n = Math.round((fromDayKey(d.due_date).getTime() - fromDayKey(today).getTime()) / 86_400_000);
    if (n < 0) return ['bad', `Dépassée de ${-n} j`];
    if (n === 0) return ['bad', "Aujourd'hui"];
    return [n <= 30 ? 'warn' : 'ok', `Dans ${n} j`];
  };

  if (deadlines.isLoading) return <Loading />;
  if (deadlines.error) return <div className="list"><p className="empty err">{frError(deadlines.error)}</p></div>;
  return (
    <>
      <Section title="Échéances à venir" right={<button type="button" className="link" onClick={() => setEdit({ title: '', category: 'controle', repeat: '12' })}>Ajouter une échéance</button>}>
        <div className="list">
          {all.length === 0 && <p className="empty">Aucune échéance suivie. Ajoute les contrôles, les contrats et les documents à renouveler : l'appli te préviendra 30 jours avant.</p>}
          {all.map((d) => {
            const [cls, label] = state(d);
            return (
              <div className="row wrap" key={d.id} data-deadline={d.title}>
                <button type="button" className="grow" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }} onClick={() => setEdit(d)} aria-label={`Modifier ${d.title}`}>
                  <span className="t">{d.title}{d.profile_id ? ` · ${fullName(who.get(d.profile_id))}` : ''}</span>
                  <span className="sub">{[DEADLINE_LABEL[d.category], `le ${fmtDateShort(d.due_date)}`, REPEATS.find(([v]) => v === String(d.repeat_months ?? ''))?.[1].toLowerCase()].filter(Boolean).join(' · ')}</span>
                  {d.note && <span className="sub">{d.note}</span>}
                </button>
                <div className="end">
                  <span className={`pill ${cls}`}>{label}</span>
                  <button type="button" className="btn sm pri" disabled={busy === d.id} onClick={() => void complete(d)}>Fait</button>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
      <Section title="Idées d'échéances à suivre">
        <div className="chips" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
          {IDEAS.filter(([t]) => !all.some((d) => d.title === t)).map(([t, c, r]) => (<button type="button" className="chip" key={t} onClick={() => setEdit({ title: t, category: c, repeat: r })}><Icon name="plus" size={16} />{t}</button>))}
        </div>
        <p className="note">Les fréquences proposées sont des usages courants. Vérifie les tiennes avec ton assureur, ton bailleur ou ton organisme de contrôle.</p>
      </Section>
      {edit && <DeadlineSheet deadline={edit} team={team} today={today} onClose={close} />}
    </>
  );
}

function DeadlineSheet({ deadline, team, today, onClose }: { deadline: Deadline | { title: string; category: DeadlineCategory; repeat: string }; team: Profile[]; today: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = 'id' in deadline ? deadline : null;
  const [title, setTitle] = useState(deadline.title);
  const [category, setCategory] = useState<DeadlineCategory>(deadline.category);
  const [due, setDue] = useState(old?.due_date ?? '');
  const [repeat, setRepeat] = useState(old ? String(old.repeat_months ?? '') : 'repeat' in deadline ? deadline.repeat : '');
  const [profile, setProfile] = useState(old?.profile_id ?? '');
  const [note, setNote] = useState(old?.note ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('deadlines', 'tasks');
    toast(done);
    onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const row = { title: title.trim(), category, due_date: due, repeat_months: repeat ? Number(repeat) : null, profile_id: category === 'document' && profile ? profile : null, note: note.trim() };
    void (old ? run(() => supabase.from('deadlines').update(row).eq('id', old.id), 'Échéance enregistrée') : run(() => supabase.from('deadlines').insert(row), 'Échéance ajoutée'));
  }

  return (
    <Sheet title={old ? old.title : 'Ajouter une échéance'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Quoi"><input className="in" id="dl-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Extincteurs, bail, visite médicale…" required maxLength={100} /></Field>
        <div className="two">
          <Field label="Type">
            <select className="in" id="dl-category" value={category} onChange={(e) => setCategory(e.target.value as DeadlineCategory)}>{(Object.keys(DEADLINE_LABEL) as DeadlineCategory[]).map((c) => (<option key={c} value={c}>{DEADLINE_LABEL[c]}</option>))}</select>
          </Field>
          <Field label="Prochaine échéance"><input className="in" id="dl-due" type="date" value={due} min={old ? undefined : today} onChange={(e) => setDue(e.target.value)} required /></Field>
        </div>
        <Field label="Revient"><select className="in" id="dl-repeat" value={repeat} onChange={(e) => setRepeat(e.target.value)}>{REPEATS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}</select></Field>
        {category === 'document' && (
          <Field label="Personne concernée" hint="Visite médicale, titre de séjour, fin de période d'essai…">
            <select className="in" id="dl-profile" value={profile} onChange={(e) => setProfile(e.target.value)}><option value="">Personne en particulier</option>{team.map((p) => (<option key={p.id} value={p.id}>{fullName(p)}</option>))}</select>
          </Field>
        )}
        <Field label="Note"><input className="in" id="dl-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Prestataire, numéro de contrat…" /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && <button type="button" className="btn no block" disabled={busy} onClick={() => void run(() => supabase.from('deadlines').delete().eq('id', old.id), 'Échéance supprimée')}>Supprimer cette échéance</button>}
        <p className="note">Seul le gérant voit les échéances. Elles apparaissent sur ton accueil 30 jours avant.</p>
      </form>
    </Sheet>
  );
}
