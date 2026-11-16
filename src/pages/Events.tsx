import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useCustomers, useEvents, useRefresh, useSites, useTeam, useTodayTasks } from '../lib/data';
import { useMe } from '../lib/session';
import { appUrl, frError, supabase } from '../lib/supabase';
import { dayKey, fmtDateShort, fmtTime, fromDayKey } from '../lib/time';
import { EVENT_KIND, EVENT_PILL, EVENT_STATUS, type Customer, type EventKind, type EventStatus, type NubaEvent, type Site } from '../lib/types';

type Filter = 'tous' | EventKind;
const KINDS = Object.keys(EVENT_KIND) as EventKind[];
const euro = (v: number) => v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const hhmm = (t: string | null) => (t ?? '').slice(0, 5);
const live = (e: NubaEvent) => e.status !== 'annule' && e.status !== 'termine';

/** Événements : privatisations, concerts, expositions, prestations extérieures. */
export default function Events() {
  const me = useMe();
  const gerant = me.role === 'gerant';
  const toast = useToast();
  const tasks = useTodayTasks();
  const today = tasks.data?.day ?? dayKey(new Date());
  const [past, setPast] = useState(false);
  const [filter, setFilter] = useState<Filter>('tous');
  const events = useEvents(today, past);
  const customers = useCustomers();
  const sites = useSites();
  const team = useTeam();
  const who = useMemo(() => new Map((team.data ?? []).map((p) => [p.id, p.first_name])), [team.data]);
  const client = useMemo(() => new Map((customers.data ?? []).map((c) => [c.id, c])), [customers.data]);
  const [openId, setOpenId] = useState('');
  const [creating, setCreating] = useState(false);
  const closeOpen = useCallback(() => setOpenId(''), []);
  const closeCreate = useCallback(() => setCreating(false), []);

  const all = events.data ?? [];
  const shown = all.filter((e) => filter === 'tous' || e.kind === filter);
  const count = (s: EventStatus) => all.filter((e) => e.status === s).length;
  const open = all.find((e) => e.id === openId);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${appUrl()}#/privatiser`);
      toast('Lien du formulaire de demande copié');
    } catch {
      toast(`${appUrl()}#/privatiser`);
    }
  }

  return (
    <Layout title="Événements" right={<button type="button" className="btn sm pri" onClick={() => setCreating(true)}><Icon name="plus" size={16} />{gerant ? 'Événement' : 'Demande'}</button>}>
      {events.isLoading ? <Loading /> : events.error ? <div className="list"><p className="empty err">{frError(events.error)}</p></div> : (
        <>
          {!past && (
            <div className="stats four">
              <div className="stat"><div className="v">{count('demande')}</div><div className="k">demandes</div></div>
              <div className="stat"><div className="v">{count('devis')}</div><div className="k">devis envoyés</div></div>
              <div className="stat"><div className="v">{count('acompte')}</div><div className="k">acomptes reçus</div></div>
              <div className="stat"><div className="v">{count('confirme')}</div><div className="k">confirmés</div></div>
            </div>
          )}
          <Chips value={filter} options={[['tous', 'Tous'], ...KINDS.map((k) => [k, EVENT_KIND[k]] as [Filter, string])]} onChange={setFilter} label="Type" />
          <Section title={past ? 'Événements passés' : 'À venir'} right={<button type="button" className="link" onClick={() => setPast(!past)}>{past ? 'Voir à venir' : 'Voir les passés'}</button>}>
            <div className="list">
              {shown.length === 0 && <p className="empty">{past ? 'Aucun événement passé.' : 'Aucun événement à venir.'}</p>}
              {shown.map((e) => {
                const d = fromDayKey(e.day);
                const done = e.event_tasks.filter((t) => t.done_at).length;
                return (
                  <button type="button" className="row wrap" key={e.id} data-event={e.title} onClick={() => setOpenId(e.id)} style={live(e) ? undefined : { opacity: 0.65 }}>
                    <span className="date"><b>{d.getDate()}</b><span>{d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '')}</span></span>
                    <span className="grow">
                      <span className={`tag k-${e.kind}`}>{EVENT_KIND[e.kind]}</span>
                      <span className="t" style={{ display: 'block' }}>{e.title}</span>
                      <span className="sub" style={{ display: 'block' }}>
                        {[e.end_day ? `jusqu'au ${fmtDateShort(e.end_day)}` : hhmm(e.start_time), e.guests ? `${e.guests} pers.` : '', client.get(e.customer_id ?? '')?.name, e.event_tasks.length ? `préparation ${done}/${e.event_tasks.length}` : ''].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="end">
                      <span className={`pill ${EVENT_PILL[e.status]}`}>{EVENT_STATUS[e.status]}</span>
                      <span className="chev"><Icon name="chev" size={18} /></span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
          {gerant && (
            <>
              <button type="button" className="btn" onClick={() => void copyLink()}><Icon name="copy" />Copier le lien du formulaire de demande</button>
              <p className="note">Ce lien se place sur le site web ou s'envoie à un client : sa demande de privatisation ou de prestation extérieure arrive ici, comme « demande ».</p>
            </>
          )}
        </>
      )}
      {open && <EventSheet key={open.id} event={open} gerant={gerant} customers={customers.data ?? []} sites={(sites.data ?? []).filter((s) => s.active)} who={who} onClose={closeOpen} />}
      {creating && (gerant
        ? <EventSheet event="new" gerant customers={customers.data ?? []} sites={(sites.data ?? []).filter((s) => s.active)} who={who} onClose={closeCreate} />
        : <RequestSheet customers={(customers.data ?? []).filter((c) => c.active)} today={today} onClose={closeCreate} />)}
    </Layout>
  );
}

/* ---------- Un événement : détails, préparation, et pour le gérant tout le reste ---------- */
function EventSheet({ event, gerant, customers, sites, who, onClose }: { event: NubaEvent | 'new'; gerant: boolean; customers: Customer[]; sites: Site[]; who: Map<string, string>; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = event === 'new' ? null : event;
  const [f, setF] = useState({
    kind: old?.kind ?? 'privatisation', title: old?.title ?? '', day: old?.day ?? '', end_day: old?.end_day ?? '', start_time: hhmm(old?.start_time ?? null),
    guests: old?.guests != null ? String(old.guests) : '', status: old?.status ?? 'confirme', customer_id: old?.customer_id ?? '', site_id: old?.site_id ?? '',
    amount: old?.amount != null ? String(old.amount).replace('.', ',') : '', deposit: old?.deposit != null ? String(old.deposit).replace('.', ',') : '',
    deposit_paid: old?.deposit_paid ?? false, details: old?.details ?? '', note: old?.note ?? '',
  });
  const [task, setTask] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const customer = customers.find((c) => c.id === old?.customer_id);
  const tasks = [...(old?.event_tasks ?? [])].sort((a, b) => a.position - b.position);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string, close: boolean) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(/events_days/.test(error.message) ? 'La date de fin est avant la date de début.' : frError(error));
    await refresh('events', 'tasks');
    if (done) toast(done);
    if (close) onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const n = (v: string) => (v.trim() === '' ? '' : String(Number(v.replace(',', '.'))));
    if ([f.amount, f.deposit].some((v) => v.trim() !== '' && Number.isNaN(Number(v.replace(',', '.'))))) return setErr('Vérifie les montants.');
    void run(() => supabase.rpc('save_event', { p_id: old?.id ?? null, p: { ...f, amount: n(f.amount), deposit: n(f.deposit) } }), old ? 'Événement enregistré' : 'Événement créé', true);
  }

  return (
    <Sheet title={old ? old.title : 'Nouvel événement'} onClose={onClose}>
      {old && (
        <Section title="À préparer">
          <div className="list">
            {tasks.length === 0 && <p className="empty">Rien à préparer pour l'instant.</p>}
            {tasks.map((t) => (
              <div className="row" key={t.id} style={{ padding: 0 }}>
                <button type="button" className={'row grow' + (t.done_at ? ' done' : '')} aria-pressed={!!t.done_at} disabled={busy}
                  onClick={() => void run(() => supabase.rpc('tick_event_task', { p_task: t.id, p_done: !t.done_at }), '', false)}>
                  <span className="chk"><Icon name="tick" size={16} /></span>
                  <span className="grow"><span className="t">{t.label}</span>{t.done_at && <span className="sub">Fait par {who.get(t.done_by ?? '') ?? 'un ancien membre'}, le {fmtDateShort(new Date(t.done_at))} à {fmtTime(t.done_at)}</span>}</span>
                </button>
                {gerant && <button type="button" className="btn sm no" style={{ marginRight: 10 }} disabled={busy} aria-label={`Retirer « ${t.label} »`} onClick={() => void run(() => supabase.from('event_tasks').delete().eq('id', t.id), '', false)}><Icon name="x" size={16} /></button>}
              </div>
            ))}
          </div>
          {gerant && (
            <div className="edit-row">
              <input className="in" id="evt-task" value={task} onChange={(e) => setTask(e.target.value)} placeholder="Ajouter une chose à préparer" aria-label="Chose à préparer" maxLength={120} />
              <button type="button" className="btn sm" disabled={busy || !task.trim()}
                onClick={() => { const label = task.trim(); setTask(''); void run(() => supabase.from('event_tasks').insert({ event_id: old.id, label, position: tasks.length + 1 }), '', false); }}>Ajouter</button>
            </div>
          )}
        </Section>
      )}

      {!gerant && old ? (
        <div className="list">
          <div className="row"><div className="grow"><span className="sub">Quand</span><span className="t">{fromDayKey(old.day).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}{old.end_day ? ` au ${fmtDateShort(old.end_day)}` : ''}{old.start_time ? ` à ${hhmm(old.start_time)}` : ''}</span></div><span className={`pill ${EVENT_PILL[old.status]}`}>{EVENT_STATUS[old.status]}</span></div>
          {old.guests != null && <div className="row"><div className="grow"><span className="sub">Personnes</span><span className="t">{old.guests}</span></div></div>}
          {customer && <div className="row"><div className="grow"><span className="sub">Client</span><span className="t">{customer.name}</span><span className="sub">{[customer.phone, customer.email].filter(Boolean).join(' · ')}</span></div></div>}
          {old.details && <div className="row"><div className="grow"><span className="sub">Déroulé et formule</span><span className="t" style={{ fontWeight: 500, whiteSpace: 'pre-wrap' }}>{old.details}</span></div></div>}
          {old.note && <div className="row"><div className="grow"><span className="sub">À savoir</span><span className="t" style={{ fontWeight: 500, whiteSpace: 'pre-wrap' }}>{old.note}</span></div></div>}
        </div>
      ) : (
        <form className="form" onSubmit={save}>
          <div className="two">
            <Field label="Type">
              <select className="in" id="evt-kind" value={f.kind} onChange={set('kind')}>{KINDS.map((k) => (<option key={k} value={k}>{EVENT_KIND[k]}</option>))}</select>
            </Field>
            <Field label="Où en est-on ?">
              <select className="in" id="evt-status" value={f.status} onChange={set('status')}>{(Object.keys(EVENT_STATUS) as EventStatus[]).map((s) => (<option key={s} value={s}>{EVENT_STATUS[s]}</option>))}</select>
            </Field>
          </div>
          <Field label="Titre"><input className="in" id="evt-title" value={f.title} onChange={set('title')} placeholder="Anniversaire de Nadia, vernissage…" required maxLength={100} /></Field>
          <div className="two">
            <Field label="Date"><input className="in" id="evt-day" type="date" value={f.day} onChange={set('day')} required /></Field>
            <Field label="Heure de début"><input className="in" id="evt-time" type="time" value={f.start_time} onChange={set('start_time')} /></Field>
          </div>
          <div className="two">
            <Field label="Dernier jour" hint="Pour une exposition ou un événement sur plusieurs jours."><input className="in" id="evt-end" type="date" value={f.end_day} min={f.day || undefined} onChange={set('end_day')} /></Field>
            <Field label="Nombre de personnes"><input className="in" id="evt-guests" inputMode="numeric" value={f.guests} onChange={set('guests')} /></Field>
          </div>
          <Field label="Client, artiste ou prestataire" hint="À créer d'abord dans Clients s'il n'y figure pas.">
            <select className="in" id="evt-customer" value={f.customer_id} onChange={set('customer_id')}>
              <option value="">Aucun</option>
              {customers.filter((c) => c.active || c.id === f.customer_id).map((c) => (<option key={c.id} value={c.id}>{c.name}{c.company ? ` (${c.company})` : ''}</option>))}
            </select>
          </Field>
          {f.kind === 'exterieur' && sites.length > 0 && (
            <Field label="Lieu de pointage" hint="Le lieu créé dans Réglages pour cette prestation : l'équipe y pointera.">
              <select className="in" id="evt-site" value={f.site_id} onChange={set('site_id')}><option value="">Aucun</option>{sites.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}</select>
            </Field>
          )}
          <div className="two">
            <Field label={f.kind === 'concert' ? 'Cachet (€)' : 'Montant du devis (€)'}><input className="in" id="evt-amount" inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
            <Field label="Acompte (€)"><input className="in" id="evt-deposit" inputMode="decimal" value={f.deposit} onChange={set('deposit')} /></Field>
          </div>
          <label className="row" style={{ padding: 0, gap: 10 }}>
            <input id="evt-paid" type="checkbox" checked={f.deposit_paid} onChange={(e) => setF((s) => ({ ...s, deposit_paid: e.target.checked }))} style={{ width: 22, height: 22 }} />
            <span className="t">Acompte encaissé</span>
          </label>
          <Field label="Déroulé et formule" hint="Menu, horaires, technique, commission… Toute l'équipe le lit.">
            <textarea className="in" id="evt-details" value={f.details} onChange={set('details')} maxLength={2000} />
          </Field>
          <Field label="À savoir"><input className="in" id="evt-note" value={f.note} onChange={set('note')} maxLength={1000} placeholder="Allergies, contraintes, message du client…" /></Field>
          {old?.amount != null && <p className="sub">Reste à encaisser : <b className="num">{euro(Math.max(0, old.amount - (old.deposit_paid ? old.deposit ?? 0 : 0)))}</b></p>}
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
          {old && (confirm ? (
            <div className="acts">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
              <button type="button" className="btn no" disabled={busy} onClick={() => void run(() => supabase.from('events').delete().eq('id', old.id), 'Événement supprimé', true)}>Supprimer définitivement</button>
            </div>
          ) : <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Supprimer cet événement</button>)}
        </form>
      )}
      {!gerant && err && <p className="err" role="alert">{err}</p>}
    </Sheet>
  );
}

/* ---------- L'équipe note une demande reçue au bar ou par téléphone ---------- */
function RequestSheet({ customers, today, onClose }: { customers: Customer[]; today: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [kind, setKind] = useState<EventKind>('privatisation');
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [guests, setGuests] = useState('');
  const [customer, setCustomer] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('request_event', { p_kind: kind, p_title: title, p_day: day, p_guests: guests.trim() === '' ? null : Number(guests), p_customer: customer || null, p_note: note });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('events', 'tasks');
    toast('Demande notée : le gérant la traitera');
    onClose();
  }

  return (
    <Sheet title="Noter une demande" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <div className="two">
          <Field label="Type"><select className="in" id="req-kind" value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>{KINDS.map((k) => (<option key={k} value={k}>{EVENT_KIND[k]}</option>))}</select></Field>
          <Field label="Date souhaitée"><input className="in" id="req-day" type="date" value={day} min={today} onChange={(e) => setDay(e.target.value)} required /></Field>
        </div>
        <Field label="Titre"><input className="in" id="req-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pot de départ, concert, cocktail…" required maxLength={100} /></Field>
        <div className="two">
          <Field label="Nombre de personnes"><input className="in" id="req-guests" inputMode="numeric" value={guests} onChange={(e) => setGuests(e.target.value)} /></Field>
          <Field label="Client" hint="À créer d'abord dans Clients s'il n'y figure pas.">
            <select className="in" id="req-customer" value={customer} onChange={(e) => setCustomer(e.target.value)}><option value="">Aucun</option>{customers.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}</select>
          </Field>
        </div>
        <Field label="Ce que la personne demande"><textarea className="in" id="req-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer la demande'}</button>
        <p className="note">Le gérant reprend la demande pour le devis et la confirmation.</p>
      </form>
    </Sheet>
  );
}
