import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useBookingSettings, useOpeningHours, usePendingBookings, useRefresh, useReservations, useTodayTasks } from '../lib/data';
import { appUrl, frError, supabase } from '../lib/supabase';
import { addDays, dayKey, fmtDayLong, fromDayKey } from '../lib/time';
import { SOURCE_LABEL, WEEKDAYS, type BookingSettings, type OpeningHour, type Reservation, type ReservationSource, type ReservationStatus } from '../lib/types';
import { useCan } from '../lib/rights';

const hhmm = (t: string | null) => (t ?? '').slice(0, 5);
const active = (r: Reservation) => r.status === 'confirmed' || r.status === 'seated';
const STATUS: Record<ReservationStatus, [string, string]> = {
  pending: ['warn', 'À valider'], confirmed: ['info', 'Attendus'], seated: ['ok', 'À table'], no_show: ['bad', 'Absents'], cancelled: ['', 'Annulée'], declined: ['', 'Refusée'],
};
const shortDay = (k: string) => fromDayKey(k).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

/** Réservations de tables : celles des clients en ligne et celles saisies par l'équipe. */
export default function Reservations() {
  const can = useCan();
  const editor = can('reservations');
  const toast = useToast();
  const refresh = useRefresh();
  const tasks = useTodayTasks();
  const today = tasks.data?.day ?? dayKey(new Date());
  const [day, setDay] = useState('');
  const shown = day || today;
  const list = useReservations(shown);
  const pending = usePendingBookings(tasks.data?.day ?? today);
  const [edit, setEdit] = useState<Reservation | 'new' | null>(null);
  const [decide, setDecide] = useState<Reservation | null>(null);
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState('');
  const closeEdit = useCallback(() => setEdit(null), []);
  const closeSettings = useCallback(() => setSettings(false), []);
  const closeDecide = useCallback(() => setDecide(null), []);

  const all = list.data ?? [];
  const kept = all.filter(active);
  const covers = kept.reduce((t, r) => t + r.party, 0);
  const groups: [string, Reservation[]][] = [['Midi', all.filter((r) => r.slot < '15:00')], ['Soir', all.filter((r) => r.slot >= '15:00')]];
  const move = (n: number) => setDay(dayKey(addDays(fromDayKey(shown), n)));

  async function setStatus(r: Reservation, status: ReservationStatus, done: string) {
    setBusy(r.id);
    const { error } = await supabase.rpc('set_reservation_status', { p_id: r.id, p_status: status });
    setBusy('');
    if (error) return toast(frError(error), 'bad');
    await refresh('reservations', 'tasks');
    toast(done);
  }

  async function accept(r: Reservation) {
    setBusy(r.id);
    const { error } = await supabase.rpc('decide_booking', { p_id: r.id, p_accept: true, p_message: '' });
    setBusy('');
    if (error) return toast(frError(error), 'bad');
    await refresh('reservations', 'tasks');
    toast(r.email ? `${r.name} : réservation confirmée, le client est prévenu par e-mail` : `${r.name} : confirmée. Pas d'e-mail : appelle le ${r.phone || 'client'}`);
  }

  const asks = pending.data ?? [];

  return (
    <Layout title="Réservations" right={<button type="button" className="btn sm pri" onClick={() => setEdit('new')}><Icon name="plus" size={16} />Réservation</button>}>
      <div className="weeknav">
        <button type="button" className="btn sm" aria-label="Jour précédent" onClick={() => move(-1)}><Icon name="back" size={16} /></button>
        <p className="lead">{fmtDayLong(fromDayKey(shown)).replace(/^./, (c) => c.toUpperCase())}</p>
        <button type="button" className="btn sm" aria-label="Jour suivant" onClick={() => move(1)}><Icon name="chev" size={16} /></button>
      </div>
      <div className="acts">
        <input className="in" id="res-day" type="date" style={{ flex: '1 1 150px' }} value={shown} onChange={(e) => setDay(e.target.value)} aria-label="Choisir un jour" />
        {shown !== today && <button type="button" className="btn" onClick={() => setDay('')}>Revenir à aujourd'hui</button>}
        {editor && <button type="button" className="btn" onClick={() => setSettings(true)}><Icon name="cog" />Réglages et lien de réservation</button>}
      </div>

      {asks.length > 0 && (
        <Section title={`Demandes à valider · ${asks.length}`}>
          <p className="note">Au-delà du nombre de personnes choisi dans les réglages, une réservation en ligne attend ta réponse. Sa place est gardée en attendant.</p>
          <div className="list" id="res-pending">
            {asks.map((r) => (
              <div className="row wrap" key={r.id} data-ask={r.name}>
                <div className="grow">
                  <span className="t">{r.name} · {r.party} pers.</span>
                  <span className="sub">{shortDay(r.day)} à {hhmm(r.slot)} · {[r.phone, r.email].filter(Boolean).join(' · ')}</span>
                  {r.note && <span className="sub">{r.note}</span>}
                </div>
                <div className="end">
                  <button type="button" className="btn sm" disabled={busy === r.id} onClick={() => setDecide(r)}>Refuser</button>
                  <button type="button" className="btn sm pri" disabled={busy === r.id} onClick={() => void accept(r)}>Accepter</button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {list.isLoading ? <Loading /> : list.error ? <div className="list"><p className="empty err">{frError(list.error)}</p></div> : (
        <>
          <div className="stats">
            <div className="stat"><div className="v">{kept.length}</div><div className="k">réservation{kept.length > 1 ? 's' : ''}</div></div>
            <div className="stat"><div className="v">{covers}</div><div className="k">couvert{covers > 1 ? 's' : ''}</div></div>
            <div className="stat"><div className="v">{kept.filter((r) => r.status === 'seated').length}</div><div className="k">déjà à table</div></div>
          </div>
          {all.length === 0 && <div className="list"><p className="empty">Aucune réservation ce jour-là.</p></div>}
          {groups.filter(([, rows]) => rows.length > 0).map(([label, rows]) => (
            <Section key={label} title={`${label} · ${rows.filter(active).reduce((t, r) => t + r.party, 0)} couverts`}>
              <div className="list">
                {rows.map((r) => (
                  <div className="row wrap" key={r.id} data-res={r.name} style={active(r) ? undefined : { opacity: 0.65 }}>
                    <span className="t num" style={{ minWidth: 46 }}>{hhmm(r.slot)}</span>
                    <button type="button" className="grow" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }} onClick={() => setEdit(r)} aria-label={`Modifier la réservation de ${r.name}`}>
                      <span className="t">{r.name} · {r.party} pers.</span>
                      <span className="sub">{[r.table_label, SOURCE_LABEL[r.source], r.phone].filter(Boolean).join(' · ')}</span>
                      {r.note && <span className="sub">{r.note}</span>}
                    </button>
                    <div className="end">
                      {r.status === 'confirmed' ? (
                        <>
                          <button type="button" className="btn sm" disabled={busy === r.id} onClick={() => void setStatus(r, 'no_show', `${r.name} : noté absent`)}>Absents</button>
                          <button type="button" className="btn sm pri" disabled={busy === r.id} onClick={() => void setStatus(r, 'seated', `${r.name} : à table`)}>Arrivés</button>
                        </>
                      ) : (
                        <>
                          <span className={`pill ${STATUS[r.status]?.[0] ?? ''}`}>{STATUS[r.status]?.[1] ?? r.status}</span>
                          {r.status !== 'pending' && r.status !== 'declined' && (
                            <button type="button" className="btn sm" disabled={busy === r.id} onClick={() => void setStatus(r, 'confirmed', `${r.name} : de nouveau attendu`)}>Rétablir</button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          ))}
        </>
      )}

      {edit && <ReservationSheet res={edit} day={shown} onClose={closeEdit} />}
      {settings && <BookingSettingsSheet onClose={closeSettings} />}
      {decide && <DeclineSheet res={decide} onClose={closeDecide} />}
    </Layout>
  );
}

/* ---------- Refuser une demande, avec un mot pour le client ---------- */
function DeclineSheet({ res, onClose }: { res: Reservation; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [message, setMessage] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function decline(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('decide_booking', { p_id: res.id, p_accept: false, p_message: message.trim() });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('reservations', 'tasks');
    toast(res.email ? `Demande de ${res.name} refusée, le client est prévenu par e-mail` : `Demande refusée. Pas d'e-mail : appelle le ${res.phone || 'client'}`);
    onClose();
  }

  return (
    <Sheet title={`Refuser la demande de ${res.name}`} onClose={onClose}>
      <form className="form" onSubmit={decline}>
        <p className="sub">{fmtDayLong(fromDayKey(res.day))} à {hhmm(res.slot)}, {res.party} personnes.</p>
        <Field label="Un mot pour le client" hint={res.email ? "Facultatif. Il le reçoit dans l'e-mail, avec des excuses et le téléphone de la Nuba." : "Ce client n'a pas laissé d'e-mail : appelle-le pour le prévenir."}>
          <textarea className="in" id="res-decline-msg" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={600} placeholder="Ex. : le restaurant est privatisé ce soir-là, mais nous avons de la place samedi." />
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn no block" disabled={busy}>{busy ? <Spinner /> : 'Refuser la demande'}</button>
      </form>
    </Sheet>
  );
}

/* ---------- Ajouter ou modifier une réservation ---------- */
function ReservationSheet({ res, day, onClose }: { res: Reservation | 'new'; day: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = res === 'new' ? null : res;
  const [d, setD] = useState(old?.day ?? day);
  const [slot, setSlot] = useState(old ? hhmm(old.slot) : '20:00');
  const [party, setParty] = useState(String(old?.party ?? 2));
  const [name, setName] = useState(old?.name ?? '');
  const [phone, setPhone] = useState(old?.phone ?? '');
  const [email, setEmail] = useState(old?.email ?? '');
  const [notify, setNotify] = useState(true);
  const [note, setNote] = useState(old?.note ?? '');
  const [table, setTable] = useState(old?.table_label ?? '');
  const [source, setSource] = useState<ReservationSource>(old?.source ?? 'telephone');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const mailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const canMail = mailOk && d >= dayKey(new Date()) && (!old || old.status === 'confirmed' || old.status === 'pending');

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const args = { p_id: old?.id ?? null, p_day: d, p_slot: slot, p_party: Number(party), p_name: name, p_phone: phone, p_email: email.trim(), p_note: note, p_source: source, p_table: table };
    const mailing = canMail && notify;
    let { error } = await supabase.rpc('save_reservation', { ...args, p_notify: mailing });
    // Avant la mise à jour 0022, la base ne connaît pas encore l'envoi d'e-mail.
    if (error?.code === 'PGRST202') ({ error } = await supabase.rpc('save_reservation', args));
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('reservations', 'tasks');
    toast(old ? 'Réservation modifiée' : mailing ? 'Réservation ajoutée, confirmation envoyée par e-mail' : 'Réservation ajoutée');
    onClose();
  }

  async function cancel() {
    if (!old) return;
    setBusy(true);
    const { error } = await supabase.rpc('set_reservation_status', { p_id: old.id, p_status: 'cancelled' });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('reservations', 'tasks');
    toast('Réservation annulée');
    onClose();
  }

  return (
    <Sheet title={old ? `Réservation de ${old.name}` : 'Nouvelle réservation'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <div className="two">
          <Field label="Jour"><input className="in" id="res-d" type="date" value={d} onChange={(e) => setD(e.target.value)} required /></Field>
          <Field label="Heure"><input className="in" id="res-slot" type="time" value={slot} onChange={(e) => setSlot(e.target.value)} required /></Field>
        </div>
        <div className="two">
          <Field label="Nombre de personnes"><input className="in" id="res-party" type="number" inputMode="numeric" min={1} max={500} value={party} onChange={(e) => setParty(e.target.value)} required /></Field>
          <Field label="Table" hint="Facultatif."><input className="in" id="res-table" value={table} onChange={(e) => setTable(e.target.value)} maxLength={30} /></Field>
        </div>
        <Field label="Nom du client"><input className="in" id="res-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
        <div className="two">
          <Field label="Téléphone"><input className="in" id="res-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} /></Field>
          <Field label="Réservée par">
            <select className="in" id="res-source" value={source} onChange={(e) => setSource(e.target.value as ReservationSource)} disabled={!!old}>
              {(Object.keys(SOURCE_LABEL) as ReservationSource[]).filter((s) => s !== 'en_ligne' || old?.source === 'en_ligne').map((s) => (<option key={s} value={s}>{SOURCE_LABEL[s]}</option>))}
            </select>
          </Field>
        </div>
        <Field label="Note"><input className="in" id="res-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Allergie, anniversaire, poussette…" /></Field>
        <Field label="E-mail du client" hint="Facultatif : pour lui envoyer la confirmation et le rappel de la veille.">
          <input className="in" id="res-email" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} />
        </Field>
        {canMail && (
          <label className="row" style={{ padding: 0, gap: 10 }}>
            <input id="res-notify" type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span className="grow">
              <span className="t">{old ? 'Prévenir le client par e-mail' : 'Envoyer la confirmation par e-mail'}</span>
              <span className="sub">{old ? "Seulement si le jour, l'heure ou le nombre de personnes change." : 'Avec un lien pour voir ou annuler sa réservation.'}</span>
            </span>
          </label>
        )}
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && old.status !== 'cancelled' && old.status !== 'declined' && (confirm ? (
          <div className="acts">
            <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
            <button type="button" className="btn no" disabled={busy} onClick={() => void cancel()}>Annuler la réservation</button>
          </div>
        ) : <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Annuler cette réservation</button>)}
      </form>
    </Sheet>
  );
}

/* ---------- Réglages : lien public, règles, horaires (gérant) ---------- */
function BookingSettingsSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const settings = useBookingSettings(true);
  const hours = useOpeningHours(true);
  const [s, setS] = useState<BookingSettings | null>(null);
  const [capacity, setCapacity] = useState('');
  const [review, setReview] = useState('');
  const [h, setH] = useState<OpeningHour[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const link = `${appUrl()}#/reserver`;
  const embed = `<iframe src="${link}" title="Réserver une table à la Nuba" style="width:100%;height:900px;border:0"></iframe>`;

  useEffect(() => {
    if (settings.data && !s) {
      setS(settings.data);
      setCapacity(settings.data.capacity_per_slot ? String(settings.data.capacity_per_slot) : '');
      setReview(settings.data.review_from ? String(settings.data.review_from) : '');
    }
  }, [settings.data, s]);
  useEffect(() => {
    if (hours.data && h.length === 0) setH(hours.data);
  }, [hours.data, h.length]);

  const setHour = (weekday: number, patch: Partial<OpeningHour>) => setH((a) => a.map((x) => (x.weekday === weekday ? { ...x, ...patch } : x)));

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast('Copie impossible : sélectionne le texte à la main', 'bad');
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!s) return;
    const cap = capacity.trim() === '' ? null : Number(capacity);
    if (cap !== null && (!Number.isInteger(cap) || cap < 1)) return setErr('La capacité est un nombre entier, ou vide pour ne pas limiter.');
    if (h.some((x) => x.open && hhmm(x.last_slot) < hhmm(x.first_slot))) return setErr('Le dernier créneau doit être après le premier.');
    if (h.some((x) => (x.break_from ? 1 : 0) + (x.break_to ? 1 : 0) === 1)) return setErr("Pour une coupure, indique son début et sa fin.");
    setBusy(true);
    setErr('');
    // Le seuil des demandes à valider n'existe qu'après la mise à jour 0022.
    const extra = 'review_from' in s ? { review_from: review ? Number(review) : null } : {};
    const results = await Promise.all([
      supabase.from('booking_settings').update({ online_enabled: s.online_enabled, slot_minutes: s.slot_minutes, max_party_online: s.max_party_online, min_lead_minutes: s.min_lead_minutes, max_days_ahead: s.max_days_ahead, capacity_per_slot: cap, phone: s.phone.trim(), notice: s.notice.trim(), ...extra }).eq('id', true),
      ...h.map((x) => supabase.from('opening_hours').update({ open: x.open, first_slot: hhmm(x.first_slot), last_slot: hhmm(x.last_slot), break_from: x.break_from ? hhmm(x.break_from) : null, break_to: x.break_to ? hhmm(x.break_to) : null }).eq('weekday', x.weekday)),
    ]);
    setBusy(false);
    const failed = results.find((r) => r.error);
    if (failed?.error) return setErr(/opening_hours_break/.test(failed.error.message) ? 'La fin de la coupure doit être après son début.' : frError(failed.error));
    await refresh('booking');
    toast('Réglages des réservations enregistrés');
    onClose();
  }

  return (
    <Sheet title="Réservation en ligne" onClose={onClose}>
      {!s || h.length === 0 ? (settings.error || hours.error ? <p className="err">{frError(settings.error ?? hours.error)}</p> : <Loading />) : (
        <form className="form" onSubmit={save}>
          <Field label="Lien à donner aux clients" hint="À mettre sur le site, dans la bio Instagram et sur la fiche Google.">
            <input className="in" id="bk-link" readOnly value={link} onFocus={(e) => e.target.select()} />
          </Field>
          <div className="acts">
            <button type="button" className="btn sm" onClick={() => void copy(link, 'Lien copié')}><Icon name="copy" size={16} />Copier le lien</button>
            <button type="button" className="btn sm" onClick={() => void copy(embed, "Code d'intégration copié")}><Icon name="copy" size={16} />Copier le code pour le site web</button>
          </div>
          <p className="note">Le code s'ajoute dans une page du site, à l'endroit où le formulaire doit apparaître (bloc « HTML » ou « code intégré » de l'éditeur du site). Les réservations faites sur le site arrivent alors directement ici.</p>

          <label className="row" style={{ padding: 0, gap: 10 }}>
            <input id="bk-online" type="checkbox" checked={s.online_enabled} onChange={(e) => setS({ ...s, online_enabled: e.target.checked })} style={{ width: 22, height: 22 }} />
            <span className="grow"><span className="t">Réservation en ligne ouverte</span><span className="sub">Décoche pour la fermer : la page invite alors à appeler.</span></span>
          </label>

          <div className="two">
            <Field label="Téléphone affiché aux clients"><input className="in" id="bk-phone" type="tel" value={s.phone} onChange={(e) => setS({ ...s, phone: e.target.value })} maxLength={30} /></Field>
            <Field label="En ligne jusqu'à" hint="Au-delà, le client doit appeler.">
              <select className="in" id="bk-max" value={s.max_party_online} onChange={(e) => setS({ ...s, max_party_online: Number(e.target.value) })}>
                {[4, 6, 8, 9, 10, 12, 15, 20].map((n) => (<option key={n} value={n}>{n} personnes</option>))}
              </select>
            </Field>
          </div>
          <div className="two">
            <Field label="Un créneau toutes les">
              <select className="in" id="bk-slot" value={s.slot_minutes} onChange={(e) => setS({ ...s, slot_minutes: Number(e.target.value) })}>
                <option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>heures</option>
              </select>
            </Field>
            <Field label="Réservation au plus tard">
              <select className="in" id="bk-lead" value={s.min_lead_minutes} onChange={(e) => setS({ ...s, min_lead_minutes: Number(e.target.value) })}>
                <option value={0}>jusqu'au dernier moment</option><option value={30}>30 minutes avant</option><option value={60}>1 heure avant</option><option value={120}>2 heures avant</option><option value={240}>4 heures avant</option><option value={1440}>la veille</option>
              </select>
            </Field>
          </div>
          <div className="two">
            <Field label="Couverts par créneau" hint="Nombre de personnes pouvant arriver à la même heure. Vide : pas de limite.">
              <input className="in" id="bk-cap" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
            </Field>
            <Field label="Jusqu'à combien de jours à l'avance">
              <select className="in" id="bk-ahead" value={s.max_days_ahead} onChange={(e) => setS({ ...s, max_days_ahead: Number(e.target.value) })}>
                {[14, 30, 60, 90, 180].map((n) => (<option key={n} value={n}>{n} jours</option>))}
              </select>
            </Field>
          </div>
          {'review_from' in s ? (
            <Field label="Demande à valider à partir de" hint="Au-delà, la réservation en ligne attend ta réponse : le client reçoit « demande reçue », puis la confirmation quand l'équipe accepte.">
              <select className="in" id="bk-review" value={review} onChange={(e) => setReview(e.target.value)}>
                <option value="">Jamais : toujours confirmée tout de suite</option>
                {[...new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, Number(review) || 2])].filter((n) => n <= s.max_party_online || String(n) === review).sort((a, b) => a - b).map((n) => (
                  <option key={n} value={n}>{n} personnes</option>
                ))}
              </select>
            </Field>
          ) : <p className="note">Demandes à valider : le gérant doit d'abord exécuter la mise à jour 0022 dans Supabase.</p>}
          <Field label="Message affiché sous le titre" hint="Facultatif : terrasse selon météo, concert le vendredi…">
            <input className="in" id="bk-notice" value={s.notice} onChange={(e) => setS({ ...s, notice: e.target.value })} maxLength={120} />
          </Field>

          <div className="field">
            <span>Créneaux réservables, jour par jour</span>
            <small>Premier et dernier créneau proposés aux clients. La coupure retire des créneaux en milieu de journée.</small>
            {h.map((x) => (
              <div key={x.weekday} className="list" style={{ padding: 10, display: 'grid', gap: 8 }}>
                <label className="row" style={{ padding: 0, gap: 10 }}>
                  <input type="checkbox" checked={x.open} onChange={(e) => setHour(x.weekday, { open: e.target.checked })} style={{ width: 20, height: 20 }} aria-label={`${WEEKDAYS[x.weekday - 1]} ouvert`} />
                  <span className="t grow">{WEEKDAYS[x.weekday - 1]}</span>
                  {!x.open && <span className="pill">Fermé</span>}
                </label>
                {x.open && (
                  <>
                    <div className="hours-row">
                      <span className="sub">Créneaux</span>
                      <input className="in" type="time" value={hhmm(x.first_slot)} onChange={(e) => setHour(x.weekday, { first_slot: e.target.value })} aria-label={`${WEEKDAYS[x.weekday - 1]}, premier créneau`} required />
                      <input className="in" type="time" value={hhmm(x.last_slot)} onChange={(e) => setHour(x.weekday, { last_slot: e.target.value })} aria-label={`${WEEKDAYS[x.weekday - 1]}, dernier créneau`} required />
                    </div>
                    <div className="hours-row">
                      <span className="sub">Coupure</span>
                      <input className="in" type="time" value={hhmm(x.break_from)} onChange={(e) => setHour(x.weekday, { break_from: e.target.value || null })} aria-label={`${WEEKDAYS[x.weekday - 1]}, début de coupure`} />
                      <input className="in" type="time" value={hhmm(x.break_to)} onChange={(e) => setHour(x.weekday, { break_to: e.target.value || null })} aria-label={`${WEEKDAYS[x.weekday - 1]}, fin de coupure`} />
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer les réglages'}</button>
        </form>
      )}
    </Sheet>
  );
}
