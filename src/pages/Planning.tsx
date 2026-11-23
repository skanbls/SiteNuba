import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { DocumentSheet } from '../components/Documents';
import { Icon } from '../components/Icon';
import { Avatar, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useLeaves, useRefresh, useShifts, useSites, useSwaps, useTeam } from '../lib/data';
import { useMe, useSession } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { addDays, dayKey, fmtDateShort, fmtDur, fmtTime, shiftRange, timeInput, weekStart } from '../lib/time';
import { ABSENCE_REASONS, LEAVE_LABEL, PART_LABEL, REASON_LABEL, REASON_SHORT, STATUS_LABEL, STATUS_PILL, fullName, type LeavePart, type LeaveReason, type LeaveRequest, type Profile, type Shift, type ShiftSwap, type Site } from '../lib/types';
import { useCan } from '../lib/rights';

const AREAS = ['Salle', 'Bar', 'Cuisine'];
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const areaClass = (a: string) => ({ salle: 'a-salle', bar: 'a-bar', cuisine: 'a-cuisine' } as Record<string, string>)[a.trim().toLowerCase()] ?? 'a-autre';
const shiftMs = (s: Pick<Shift, 'starts_at' | 'ends_at'>) => new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime();
const hours = (h: number) => String(h).replace('.', ',');
/** Service décrit en une ligne : ven. 20 nov., 18:00 – 01:00, Salle. */
const shiftLine = (s: Pick<Shift, 'starts_at' | 'ends_at' | 'area'>) =>
  `${new Date(s.starts_at).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}${s.area ? `, ${s.area}` : ''}`;
const leaveOn = (leaves: LeaveRequest[], profileId: string, day: string) =>
  leaves.find((l) => l.status === 'approved' && l.profile_id === profileId && l.start_date <= day && day <= l.end_date);
const onLeave = (leaves: LeaveRequest[], profileId: string, day: string) => !!leaveOn(leaves, profileId, day);
/** Nom d'une absence : son motif quand on a le droit de le voir, sinon simplement « Absence ». */
const leaveName = (l: LeaveRequest) => (l.kind === 'indisponibilite' ? LEAVE_LABEL.indisponibilite : l.reason ? REASON_LABEL[l.reason] : 'Absence');
/** Ce qu'affiche la case du planning : « CP », « Maladie », « Absent (matin) »… */
const leaveTag = (l: LeaveRequest) =>
  `${l.kind === 'indisponibilite' ? 'Indispo' : l.reason ? REASON_SHORT[l.reason] : 'Absent'}${l.part === 'am' ? ' (matin)' : l.part === 'pm' ? ' (ap.-midi)' : ''}`;

type Editing = { shift: Shift } | { profileId: string; day: string } | null;

export default function Planning() {
  const me = useMe();
  const can = useCan();
  const editor = can('planning');
  const manager = me.role !== 'equipier';
  const toast = useToast();
  const refresh = useRefresh();
  const todayKey = dayKey(new Date());
  const thisWeek = useMemo(() => weekStart(new Date()), []);
  const [week, setWeek] = useState(thisWeek);
  const [day, setDay] = useState(todayKey);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);
  const weekEnd = useMemo(() => addDays(week, 7), [week]);

  const shifts = useShifts(week, weekEnd);
  const team = useTeam();
  const sites = useSites();
  const leaves = useLeaves(dayKey(addDays(thisWeek, -7)));
  const swaps = useSwaps();
  const people = useMemo(() => new Map((team.data ?? []).map((p) => [p.id, p])), [team.data]);
  const active = (team.data ?? []).filter((p) => p.active);
  const list = shifts.data ?? [];
  const allLeaves = leaves.data ?? [];

  const [editing, setEditing] = useState<Editing>(null);
  const [leaveSheet, setLeaveSheet] = useState(false);
  const [swapSheet, setSwapSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeLeave = useCallback(() => setLeaveSheet(false), []);
  const { pin } = useSession();
  const [arret, setArret] = useState(false);
  const closeArret = useCallback(() => setArret(false), []);
  const closeSwap = useCallback(() => setSwapSheet(false), []);

  const go = (w: Date) => {
    setWeek(w);
    const k = dayKey(new Date());
    setDay(w.getTime() === thisWeek.getTime() ? k : dayKey(w));
  };

  const ofDay = list.filter((s) => dayKey(s.starts_at) === day).sort((a, b) => {
    const ia = AREAS.indexOf(a.area), ib = AREAS.indexOf(b.area);
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.starts_at.localeCompare(b.starts_at);
  });

  const totals = active.map((p) => ({ p, ms: list.filter((s) => s.profile_id === p.id).reduce((t, s) => t + shiftMs(s), 0) }));
  const weekLeaves = allLeaves.filter((l) => l.status === 'approved' && l.start_date < dayKey(weekEnd) && l.end_date >= dayKey(week));
  const pendingLeaves = allLeaves.filter((l) => l.status === 'pending');
  const pendingSwaps = (swaps.data ?? []).filter((w) => w.status === 'pending');
  const myLeaves = allLeaves.filter((l) => l.profile_id === me.id);
  const mySwaps = (swaps.data ?? []).filter((w) => w.from_profile === me.id || w.to_profile === me.id);

  async function act(run: () => PromiseLike<{ error: { message: string } | null }>, done: string, ...keys: string[]) {
    setBusy(true);
    const { error } = await run();
    setBusy(false);
    if (error) return toast(frError(error), 'bad');
    await refresh(...keys);
    toast(done);
  }

  async function copyPrevious() {
    setBusy(true);
    const prev = await supabase.from('shifts').select('*').gte('starts_at', addDays(week, -7).toISOString()).lt('starts_at', week.toISOString());
    if (prev.error) {
      setBusy(false);
      return toast(frError(prev.error), 'bad');
    }
    const rows = (prev.data as Shift[])
      .filter((s) => people.get(s.profile_id)?.active)
      .map((s) => ({ profile_id: s.profile_id, site_id: s.site_id, area: s.area, note: s.note, starts_at: addDays(new Date(s.starts_at), 7).toISOString(), ends_at: addDays(new Date(s.ends_at), 7).toISOString() }));
    if (!rows.length) {
      setBusy(false);
      return toast("La semaine précédente n'a aucun service à recopier.", 'bad');
    }
    await act(() => supabase.from('shifts').insert(rows), `${rows.length} service${rows.length > 1 ? 's' : ''} recopié${rows.length > 1 ? 's' : ''}`, 'shifts');
  }

  const leaveRow = (l: LeaveRequest, decide: boolean) => {
    const p = people.get(l.profile_id);
    return (
      <div className="row wrap" key={l.id}>
        <Avatar p={p} />
        <div className="grow">
          <span className="t">{fullName(p)} · {leaveName(l)}</span>
          <span className="sub">{l.start_date === l.end_date ? `le ${fmtDateShort(l.start_date)}${l.part && l.part !== 'full' ? `, ${PART_LABEL[l.part].toLowerCase()}` : ''}` : `du ${fmtDateShort(l.start_date)} au ${fmtDateShort(l.end_date)}`}{l.note ? ` · ${l.note}` : ''}{l.document_id ? ' · justificatif reçu' : ''}</span>
        </div>
        <div className="end">
          {decide && l.status === 'pending' ? (
            <>
              <button type="button" className="btn sm no" disabled={busy} onClick={() => void act(() => supabase.rpc('decide_leave', { p_id: l.id, p_approve: false }), 'Demande refusée', 'leaves')}>Refuser</button>
              <button type="button" className="btn sm pri" disabled={busy} onClick={() => void act(() => supabase.rpc('decide_leave', { p_id: l.id, p_approve: true }), 'Demande acceptée', 'leaves')}>Accepter</button>
            </>
          ) : (
            <>
              <span className={`pill ${STATUS_PILL[l.status]}`}>{STATUS_LABEL[l.status]}</span>
              {(editor || (l.profile_id === me.id && l.status === 'pending')) && (
                <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => supabase.from('leave_requests').delete().eq('id', l.id), editor ? 'Absence supprimée' : 'Demande annulée', 'leaves')}>{editor ? 'Supprimer' : 'Annuler'}</button>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  const swapRow = (w: ShiftSwap, decide: boolean) => (
    <div className="row wrap" key={w.id}>
      <Avatar p={people.get(w.from_profile)} />
      <div className="grow">
        <span className="t">{fullName(people.get(w.from_profile))} cède à {fullName(people.get(w.to_profile))}</span>
        <span className="sub">{w.shifts ? shiftLine(w.shifts) : 'Service supprimé'}{w.note ? ` · ${w.note}` : ''}</span>
      </div>
      <div className="end">
        {decide && w.status === 'pending' ? (
          <>
            <button type="button" className="btn sm no" disabled={busy} onClick={() => void act(() => supabase.rpc('decide_swap', { p_id: w.id, p_approve: false }), 'Échange refusé', 'swaps')}>Refuser</button>
            <button type="button" className="btn sm pri" disabled={busy} onClick={() => void act(() => supabase.rpc('decide_swap', { p_id: w.id, p_approve: true }), 'Échange accepté, le planning est à jour', 'swaps', 'shifts')}>Accepter</button>
          </>
        ) : (
          <>
            <span className={`pill ${STATUS_PILL[w.status]}`}>{STATUS_LABEL[w.status]}</span>
            {w.status === 'pending' && w.from_profile === me.id && (
              <button type="button" className="btn sm" disabled={busy} onClick={() => void act(() => supabase.from('shift_swaps').delete().eq('id', w.id), 'Demande annulée', 'swaps')}>Annuler</button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <Layout title="Planning" right={editor && <button type="button" className="btn sm pri" onClick={() => setEditing({ profileId: '', day })}><Icon name="plus" size={16} />Service</button>}>
      <div className="weeknav">
        <button type="button" className="btn sm" aria-label="Semaine précédente" onClick={() => go(addDays(week, -7))}><Icon name="back" size={16} /></button>
        <p className="lead">Semaine du {week.getDate()} au {fmtDateShort(addDays(week, 6))}</p>
        <button type="button" className="btn sm" aria-label="Semaine suivante" onClick={() => go(addDays(week, 7))}><Icon name="chev" size={16} /></button>
      </div>
      {week.getTime() !== thisWeek.getTime() && <button type="button" className="link center" onClick={() => go(thisWeek)}>Revenir à cette semaine</button>}

      <Section>
        <div className="chips" role="group" aria-label="Jour">
          {days.map((d, i) => {
            const k = dayKey(d);
            const n = list.filter((s) => dayKey(s.starts_at) === k).length;
            return (
              <button key={k} type="button" className="chip" aria-pressed={k === day} onClick={() => setDay(k)} aria-label={`${DAYS[i]} ${d.getDate()}${n > 0 ? `, ${n} service${n > 1 ? 's' : ''}` : ''}`}>
                {DAYS[i]} {d.getDate()}{n > 0 && <small className="num" style={{ opacity: 0.7 }}>{n}</small>}
              </button>
            );
          })}
        </div>
        {shifts.isLoading ? <Loading /> : shifts.error ? <div className="list"><p className="empty err">{frError(shifts.error)}</p></div> : (
          <div className="list">
            {ofDay.length === 0 && <p className="empty">Aucun service prévu ce jour-là.</p>}
            {ofDay.map((s) => {
              const p = people.get(s.profile_id);
              const body = (
                <>
                  <Avatar p={p} />
                  <div className="grow">
                    <span className="t">{fullName(p)}{s.profile_id === me.id ? ' (toi)' : ''}</span>
                    <span className={`tag ${areaClass(s.area)}`}>{s.area || 'Poste non précisé'}</span>
                    {s.note && <span className="sub">{s.note}</span>}
                  </div>
                  <div className="end">
                    {onLeave(allLeaves, s.profile_id, dayKey(s.starts_at)) && <span className="pill bad">Absent ce jour-là</span>}
                    <div style={{ textAlign: 'right' }}>
                      <span className="t num" style={{ display: 'block' }}>{fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}</span>
                      <span className="sub num">{fmtDur(shiftMs(s))}</span>
                    </div>
                  </div>
                </>
              );
              return editor
                ? <button type="button" className="row wrap" key={s.id} onClick={() => setEditing({ shift: s })}>{body}</button>
                : <div className="row wrap" key={s.id}>{body}</div>;
            })}
          </div>
        )}
        {editor && !shifts.isLoading && list.length === 0 && (
          <button type="button" className="btn" disabled={busy} onClick={() => void copyPrevious()}><Icon name="copy" />Recopier la semaine précédente</button>
        )}
      </Section>

      <Section title="Vue de la semaine">
        <div className="scroll-x">
          <table className="week">
            <thead>
              <tr>
                <th></th>
                {days.map((d, i) => (<th key={i} className={dayKey(d) === todayKey ? 'today' : undefined}>{DAYS[i]} {d.getDate()}</th>))}
              </tr>
            </thead>
            <tbody>
              {active.map((p) => (
                <tr key={p.id}>
                  <th>{p.first_name}</th>
                  {days.map((d) => {
                    const k = dayKey(d);
                    const mine = list.filter((s) => s.profile_id === p.id && dayKey(s.starts_at) === k);
                    const away = leaveOn(allLeaves, p.id, k);
                    return (
                      <td key={k}>
                        {mine.map((s) => editor ? (
                          <button type="button" key={s.id} className={`shift ${areaClass(s.area)}`} onClick={() => setEditing({ shift: s })} aria-label={`${p.first_name}, ${shiftLine(s)}`}>
                            {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}<small>{s.area || 'Poste non précisé'}</small>
                          </button>
                        ) : (
                          <span key={s.id} className={`shift ${areaClass(s.area)}`}>{fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}<small>{s.area || 'Poste non précisé'}</small></span>
                        ))}
                        {away && <span className="off away" data-away={`${p.first_name} ${k}`}>{leaveTag(away)}</span>}
                        {mine.length === 0 && (away ? null : editor ? (
                          <button type="button" className="add" onClick={() => setEditing({ profileId: p.id, day: k })} aria-label={`Ajouter un service pour ${p.first_name} le ${fmtDateShort(d)}`}>+</button>
                        ) : <span className="off">Repos</span>)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editor && <p className="note">Touche une case vide pour ajouter un service, ou un service pour le modifier.</p>}
      </Section>

      <div className="cols">
        <div className="stack">
          {manager && (pendingLeaves.length > 0 || pendingSwaps.length > 0) && (
            <Section title="Demandes à traiter">
              <div className="list">
                {pendingLeaves.map((l) => leaveRow(l, editor))}
                {pendingSwaps.map((w) => swapRow(w, editor))}
              </div>
            </Section>
          )}

          <Section title="Mes demandes">
            <div className="list">
              {myLeaves.length === 0 && mySwaps.length === 0 && <p className="empty">Aucune demande en cours.</p>}
              {myLeaves.map((l) => leaveRow(l, false))}
              {mySwaps.map((w) => swapRow(w, false))}
            </div>
            <div className="acts">
              <button type="button" className="btn" onClick={() => setLeaveSheet(true)}>{editor ? 'Saisir une absence' : 'Demander un congé'}</button>
              <button type="button" className="btn" onClick={() => setSwapSheet(true)}>Céder un service</button>
              {!pin && <button type="button" className="btn" onClick={() => setArret(true)}><Icon name="doc" size={16} />Envoyer un arrêt de travail</button>}
            </div>
          </Section>
        </div>

        <div className="stack">
          <Section title="Absences de la semaine">
            <div className="list">
              {weekLeaves.length === 0 && <p className="empty">Personne n'est absent cette semaine.</p>}
              {weekLeaves.map((l) => leaveRow(l, false))}
            </div>
          </Section>

          {manager && (
            <Section title="Heures planifiées">
              <div className="list">
                {totals.map(({ p, ms }) => {
                  const cap = p.weekly_hours * 3_600_000;
                  const extra = p.contract === 'extra' || cap === 0;
                  const over = !extra && ms > cap;
                  return (
                    <div className="row" key={p.id}>
                      <Avatar p={p} />
                      <div className="grow">
                        <span className="t">{fullName(p)}</span>
                        <span className="sub">{p.job || (extra ? 'Extra' : '')}</span>
                        {!extra && <div className={'bar' + (over ? ' over' : '')}><i style={{ width: `${Math.min(100, (ms / cap) * 100)}%` }} /></div>}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span className="t num" style={{ display: 'block' }}>{fmtDur(ms)}</span>
                        {over ? <span className="pill warn">+{fmtDur(ms - cap)}</span> : <span className="sub">{extra ? 'Extra' : `sur ${hours(p.weekly_hours)} h`}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}
        </div>
      </div>

      {editing && <ShiftSheet editing={editing} team={active} sites={(sites.data ?? []).filter((s) => s.active)} leaves={allLeaves} onClose={closeEdit} />}
      {leaveSheet && <LeaveSheet me={me} team={active} onClose={closeLeave} />}
      {arret && <DocumentSheet profileId={me.id} category="arret" onClose={closeArret} />}
      {swapSheet && <SwapSheet me={me} team={active} onClose={closeSwap} />}
    </Layout>
  );
}

/* ---------- Ajouter ou modifier un service (gérant) ---------- */
function ShiftSheet({ editing, team, sites, leaves, onClose }: { editing: Exclude<Editing, null>; team: Profile[]; sites: Site[]; leaves: LeaveRequest[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = 'shift' in editing ? editing.shift : null;
  const [who, setWho] = useState(old?.profile_id ?? ('profileId' in editing ? editing.profileId : ''));
  const [day, setDay] = useState(old ? dayKey(old.starts_at) : 'day' in editing ? editing.day : dayKey(new Date()));
  const [start, setStart] = useState(old ? timeInput(old.starts_at) : '18:00');
  const [end, setEnd] = useState(old ? timeInput(old.ends_at) : '00:00');
  const [area, setArea] = useState(old?.area ?? '');
  const [site, setSite] = useState(old?.site_id ?? sites[0]?.id ?? '');
  const [note, setNote] = useState(old?.note ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const away = who && day ? onLeave(leaves, who, day) : false;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!who) return setErr('Choisis la personne.');
    if (!day || !start || !end) return setErr('Indique le jour et les heures.');
    const row = { profile_id: who, site_id: site || null, area, note, ...shiftRange(day, start, end) };
    setBusy(true);
    setErr('');
    const { error } = old ? await supabase.from('shifts').update(row).eq('id', old.id) : await supabase.from('shifts').insert(row);
    setBusy(false);
    if (error) return setErr(/shifts_length/.test(error.message) ? "Un service ne peut pas dépasser 16 heures. Vérifie les heures." : frError(error));
    await refresh('shifts');
    toast(old ? 'Service modifié' : 'Service ajouté');
    onClose();
  }

  async function remove() {
    if (!old) return;
    setBusy(true);
    const { error } = await supabase.from('shifts').delete().eq('id', old.id);
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('shifts', 'swaps');
    toast('Service supprimé');
    onClose();
  }

  return (
    <Sheet title={old ? 'Modifier le service' : 'Ajouter un service'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Personne">
          <select className="in" id="shift-who" value={who} onChange={(e) => setWho(e.target.value)} required>
            <option value="">Choisir</option>
            {team.map((p) => (<option key={p.id} value={p.id}>{fullName(p)}</option>))}
          </select>
        </Field>
        <Field label="Jour">
          <input className="in" id="shift-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
        </Field>
        <div className="two">
          <Field label="Début">
            <input className="in" id="shift-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
          </Field>
          <Field label="Fin" hint="Une fin après minuit compte pour le lendemain.">
            <input className="in" id="shift-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </Field>
        </div>
        <Field label="Poste">
          <input className="in" id="shift-area" list="shift-areas" value={area} onChange={(e) => setArea(e.target.value)} placeholder="Salle, Bar, Cuisine…" maxLength={40} />
          <datalist id="shift-areas">{AREAS.map((a) => (<option key={a} value={a} />))}</datalist>
        </Field>
        {sites.length > 1 && (
          <Field label="Lieu">
            <select className="in" id="shift-site" value={site} onChange={(e) => setSite(e.target.value)}>
              {sites.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
            </select>
          </Field>
        )}
        <Field label="Note">
          <input className="in" id="shift-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Facultatif" />
        </Field>
        {away && <p className="err">Cette personne a une absence acceptée ce jour-là.</p>}
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && (confirm ? (
          <div className="acts">
            <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
            <button type="button" className="btn no" disabled={busy} onClick={() => void remove()}>Supprimer définitivement</button>
          </div>
        ) : (
          <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Supprimer ce service</button>
        ))}
      </form>
    </Sheet>
  );
}

/* ---------- Demander un congé, ou saisir une absence (gérant) ---------- */
function LeaveSheet({ me, team, onClose }: { me: Profile; team: Profile[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const can = useCan();
  const editor = can('planning');
  const [who, setWho] = useState(me.id);
  const [kind, setKind] = useState<LeaveRequest['kind']>('conge');
  const [reason, setReason] = useState<LeaveReason>('conges_payes');
  const [part, setPart] = useState<LeavePart>('full');
  const reasons = ABSENCE_REASONS.filter((r) => editor || r.ask);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    const end = to || from;
    if (!from) return setErr('Indique la date de début.');
    if (end < from) return setErr('La fin est avant le début.');
    setBusy(true);
    setErr('');
    const single = end === from;
    const row = { profile_id: who, kind, reason: kind === 'conge' ? reason : 'autre', part: single ? part : 'full', start_date: from, end_date: end, note: note.trim() };
    // Le gérant enregistre directement une absence acceptée ; les autres font une demande.
    const payload: Record<string, unknown> = editor ? { ...row, status: 'approved', decided_by: me.id, decided_at: new Date().toISOString() } : row;
    const { error } = await supabase.from('leave_requests').insert(payload);
    setBusy(false);
    if (error) return setErr(/leave_requests_length/.test(error.message) ? 'Trois mois au maximum par demande.' : frError(error));
    await refresh('leaves');
    toast(editor ? 'Absence enregistrée' : 'Demande envoyée au gérant');
    onClose();
  }

  return (
    <Sheet title={editor ? 'Saisir une absence' : 'Demander un congé'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        {editor && (
          <Field label="Personne">
            <select className="in" id="leave-who" value={who} onChange={(e) => setWho(e.target.value)}>
              {team.map((p) => (<option key={p.id} value={p.id}>{fullName(p)}</option>))}
            </select>
          </Field>
        )}
        <Field label="Type">
          <select className="in" id="leave-kind" value={kind} onChange={(e) => setKind(e.target.value as LeaveRequest['kind'])}>
            <option value="conge">Absence ou congé</option>
            <option value="indisponibilite">Indisponibilité (je ne peux pas travailler)</option>
          </select>
        </Field>
        {kind === 'conge' && (
          <Field label="Motif" hint={editor ? undefined : "Malade ? Envoie plutôt ton arrêt de travail : il sera noté tout seul."}>
            <select className="in" id="leave-reason" value={reason} onChange={(e) => setReason(e.target.value as LeaveReason)}>
              {reasons.map((r) => (<option key={r.key} value={r.key}>{r.label}</option>))}
            </select>
          </Field>
        )}
        <div className="two">
          <Field label="Du">
            <input className="in" id="leave-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
          </Field>
          <Field label="Au" hint="Vide pour une seule journée.">
            <input className="in" id="leave-to" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {(!to || to === from) && (
          <Field label="Durée">
            <select className="in" id="leave-part" value={part} onChange={(e) => setPart(e.target.value as LeavePart)}>
              <option value="full">Toute la journée</option>
              <option value="am">Le matin</option>
              <option value="pm">L'après-midi</option>
            </select>
          </Field>
        )}
        <Field label="Note">
          <input className="in" id="leave-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Facultatif" />
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : editor ? 'Enregistrer' : 'Envoyer la demande'}</button>
      </form>
    </Sheet>
  );
}

/* ---------- Céder un de ses services à un collègue ---------- */
function SwapSheet({ me, team, onClose }: { me: Profile; team: Profile[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const range = useMemo(() => ({ from: new Date(), to: addDays(new Date(), 60) }), []);
  const mine = useShifts(range.from, range.to, me.id);
  const [shift, setShift] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!shift || !to) return setErr('Choisis le service et le collègue.');
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('request_swap', { p_shift: shift, p_to: to, p_note: note });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('swaps');
    toast('Demande envoyée au gérant');
    onClose();
  }

  return (
    <Sheet title="Céder un service" onClose={onClose}>
      {mine.isLoading ? <Loading /> : (mine.data ?? []).length === 0 ? (
        <p className="empty">Tu n'as aucun service à venir dans le planning.</p>
      ) : (
        <form className="form" onSubmit={save}>
          <Field label="Mon service">
            <select className="in" id="swap-shift" value={shift} onChange={(e) => setShift(e.target.value)} required>
              <option value="">Choisir</option>
              {(mine.data ?? []).map((s) => (<option key={s.id} value={s.id}>{shiftLine(s)}</option>))}
            </select>
          </Field>
          <Field label="Collègue qui le reprend" hint="Mets-toi d'accord avec cette personne avant d'envoyer.">
            <select className="in" id="swap-to" value={to} onChange={(e) => setTo(e.target.value)} required>
              <option value="">Choisir</option>
              {team.filter((p) => p.id !== me.id).map((p) => (<option key={p.id} value={p.id}>{fullName(p)}</option>))}
            </select>
          </Field>
          <Field label="Note">
            <input className="in" id="swap-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="Facultatif" />
          </Field>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Envoyer la demande'}</button>
          <p className="note">Le service ne change de main qu'après l'accord du gérant.</p>
        </form>
      )}
    </Sheet>
  );
}
