import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Avatar, Layout, Loading, Section, useToast } from '../components/ui';
import { parseBoard } from '../lib/dashboard';
import { useChecklists, useClosingToday, useDashboard, useEntries, useMyOpenEntry, useOpenEntries, usePendingBookings, useShiftChanges, useShifts, useSiteWeekly, useTeam, useTodayTasks } from '../lib/data';
import { forMeToday, forMeTomorrow, isLate } from '../lib/checklists';
import { netChanges } from '../lib/shiftChanges';
import { norm } from '../lib/production';
import { useMe } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { addDays, dayKey, fmtDayLong, fmtDur, fmtTime, fromDayKey, periodRange, workedMs } from '../lib/time';
import { EVENT_KIND, fullName, type Shift, type ShiftChange, type TimeEntry } from '../lib/types';

const startOfToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/** Accueil : où j'en suis, et pour les responsables, qui est là. */
export default function Today() {
  const me = useMe();
  const manager = me.role !== 'equipier';
  // Gérants : l'état de la trésorerie et les alertes du tableau de bord financier.
  const dash = useDashboard(me.role === 'gerant');
  const board = useMemo(() => parseBoard(dash.data?.tabs?.['Tableau de bord']), [dash.data]);
  const cash = board.sections.flatMap((x) => x.rows).find((k) => /^statut/.test(norm(k.label)));
  const open = useMyOpenEntry(me.id);
  const present = useOpenEntries(manager);
  const week = periodRange('week');
  const mine = useEntries(week.from, week.to, me.id);
  const e = open.data;
  const paused = !!e?.time_breaks.some((b) => !b.ended_at);
  const weekMs = (mine.data ?? []).reduce((s, x) => s + workedMs(x), 0);
  const today = fmtDayLong(new Date());
  const day0 = useMemo(startOfToday, []);
  const day1 = useMemo(() => addDays(day0, 1), [day0]);
  const soon = useMemo(() => addDays(day0, 21), [day0]);
  const myShifts = useShifts(day0, soon, me.id);
  const teamShifts = useShifts(day0, day1);
  const dayEntries = useEntries(day0, day1);
  const team = useTeam();
  const mineToday = (myShifts.data ?? []).filter((s) => dayKey(s.starts_at) === dayKey(day0));
  const next = (myShifts.data ?? []).filter((s) => new Date(s.starts_at) >= day1).slice(0, 3);
  const people = new Map((team.data ?? []).map((p) => [p.id, p]));
  const tasks = useTodayTasks();
  const t = tasks.data;
  const pendingCount = usePendingBookings(t?.day, t?.bookings !== undefined).data?.length ?? 0;
  // Checklists d'après le planning : celles de mon poste aujourd'hui, et celles prévues demain.
  const checklists = useChecklists();
  const myLists = t ? (checklists.data ?? []).filter((l) => forMeToday(l, t.day)) : [];
  const tomorrowLists = t ? (checklists.data ?? []).filter((l) => forMeTomorrow(l, dayKey(addDays(fromDayKey(t.day), 1)))) : [];
  // Rendez-vous de chaque semaine (fichier du site) qui tombent le jour de service.
  const weekly = useSiteWeekly(!!t);
  const isoDay = t?.day ? ((fromDayKey(t.day).getDay() + 6) % 7) + 1 : 0;
  const weeklyToday = (weekly.data ?? []).filter((w) => w.weekday === isoDay);
  // Fermeture de caisse du soir, et mes services changés depuis ma dernière visite.
  const closing = useClosingToday().data;
  const changes = netChanges(useShiftChanges().data ?? []);

  return (
    <Layout title="Aujourd'hui">
      <div className="hero">
        <p>Bonjour {me.first_name}, {today}</p>
        {open.isLoading ? <p className="big">…</p> : e ? (
          <>
            <p className="big">{paused ? 'En pause' : `En service depuis ${fmtTime(e.clock_in)}`}</p>
            <p>{fmtDur(workedMs(e))} de service{e.sites ? ` · ${e.sites.name}` : ''}</p>
          </>
        ) : (
          <p className="big">Pas encore pointé</p>
        )}
        {!myShifts.error && !myShifts.isLoading && (
          <p>{mineToday.length ? `Service prévu : ${mineToday.map((s) => `${fmtTime(s.starts_at)} – ${fmtTime(s.ends_at)}${s.area ? `, ${s.area}` : ''}`).join(' puis ')}` : "Pas de service prévu aujourd'hui"}</p>
        )}
        <Link className="btn" to="/pointeuse">
          <Icon name="qr" />
          {e ? 'Ouvrir la pointeuse' : 'Pointer mon arrivée'}
        </Link>
      </div>

      {changes.length > 0 && <PlanningChanged changes={changes} />}

      {t && (
        <Section title="À faire aujourd'hui">
          <div className="list">
            {myLists.length > 0 ? myLists.map((l) => {
              const done = l.items.filter((i) => i.done).length;
              const late = isLate(l, t.day);
              return (
                <Link className="row" to={`/${l.kind === 'nettoyage' ? 'hygiene' : 'checklists'}?l=${l.id}`} key={l.id} data-my-list={l.name}>
                  <div className="grow">
                    <span className="t">{l.name}</span>
                    <span className="sub num">{done} sur {l.items.length} cases cochées{l.area ? ` · ${l.area}` : ''}</span>
                    <div className={'bar' + (l.items.length > 0 && done >= l.items.length ? ' full' : '')}><i style={{ width: `${l.items.length ? (done / l.items.length) * 100 : 0}%` }} /></div>
                  </div>
                  <div className="end">
                    {late ? <span className="pill bad">En retard</span> : l.frequency !== 'daily' && l.due_weekday && l.next_due === t.day ? <span className="pill warn">Prévue aujourd'hui</span> : null}
                    <span className="chev"><Icon name="chev" size={18} /></span>
                  </div>
                </Link>
              );
            }) : (
              <Link className="row" to="/checklists">
                <div className="grow">
                  <span className="t">Checklists du jour</span>
                  <span className="sub num">{t.checks_done} sur {t.checks_total} cases cochées</span>
                  <div className={'bar' + (t.checks_total > 0 && t.checks_done >= t.checks_total ? ' full' : '')}><i style={{ width: `${t.checks_total ? Math.min(100, (t.checks_done / t.checks_total) * 100) : 0}%` }} /></div>
                </div>
                <span className="chev"><Icon name="chev" size={18} /></span>
              </Link>
            )}
            {tomorrowLists.length > 0 && (
              <Link className="row" to={`/${tomorrowLists[0].kind === 'nettoyage' ? 'hygiene' : 'checklists'}?l=${tomorrowLists[0].id}`} data-tomorrow>
                <div className="grow">
                  <span className="t">Demain, à ton poste</span>
                  <span className="sub">{tomorrowLists.map((l) => `${l.name} (${l.items.length} tâche${l.items.length > 1 ? 's' : ''})`).join(' · ')}</span>
                </div>
                <div className="end"><span className="pill info">Rappel</span><span className="chev"><Icon name="chev" size={18} /></span></div>
              </Link>
            )}
            <Link className="row wrap" to="/hygiene">
              <div className="grow">
                <span className="t">Hygiène</span>
                <span className="sub">
                  {[t.temps_due > 0 ? `${t.temps_due} relevé${t.temps_due > 1 ? 's' : ''} de température à faire (${t.slot})` : '',
                    t.dlc_today > 0 ? `${t.dlc_today} produit${t.dlc_today > 1 ? 's' : ''} à utiliser aujourd'hui` : ''].filter(Boolean).join(' · ') || 'Relevés à jour'}
                </span>
              </div>
              <div className="end">
                {t.temps_alerts > 0 && <span className="pill bad">{t.temps_alerts} hors limite</span>}
                {t.dlc_late > 0 && <span className="pill bad">{t.dlc_late} date{t.dlc_late > 1 ? 's' : ''} dépassée{t.dlc_late > 1 ? 's' : ''}</span>}
                {t.temps_alerts === 0 && t.dlc_late === 0 && t.temps_due > 0 && <span className="pill warn">À faire</span>}
                {t.temps_alerts === 0 && t.dlc_late === 0 && t.temps_due === 0 && <span className="pill ok">À jour</span>}
                <span className="chev"><Icon name="chev" size={18} /></span>
              </div>
            </Link>
            {weeklyToday.map((w) => (
              <Link className="row" to="/evenements" key={`w${w.position}`} data-weekly-today={w.title}>
                <div className="grow">
                  <span className="tag k-soiree">Chaque {w.day_label.toLowerCase().replace(/s$/, '') || 'semaine'}</span>
                  <span className="t">{w.title}</span>
                  {w.schedule && <span className="sub">{w.schedule}</span>}
                </div>
                <span className="chev"><Icon name="chev" size={18} /></span>
              </Link>
            ))}
            {(t.events_today ?? []).map((ev) => (
              <Link className="row" to="/evenements" key={ev.id}>
                <div className="grow">
                  <span className={`tag k-${ev.kind}`}>{EVENT_KIND[ev.kind] ?? 'Événement'}, aujourd'hui</span>
                  <span className="t">{ev.title}</span>
                  <span className="sub">{[ev.start_time, ev.guests ? `${ev.guests} personnes` : ''].filter(Boolean).join(' · ')}</span>
                </div>
                <span className="chev"><Icon name="chev" size={18} /></span>
              </Link>
            ))}
            {manager && (t.event_requests ?? 0) > 0 && (
              <Link className="row" to="/evenements">
                <div className="grow">
                  <span className="t">Demandes d'événement</span>
                  <span className="sub">{t.event_requests} demande{(t.event_requests ?? 0) > 1 ? 's' : ''} à traiter</span>
                </div>
                <div className="end"><span className="pill info">À voir</span><span className="chev"><Icon name="chev" size={18} /></span></div>
              </Link>
            )}
            {me.role === 'gerant' && dash.data?.synced_at && (cash || board.alerts.length > 0) && (
              <Link className="row" to="/tableau-de-bord" data-testid="today-tresorerie">
                <div className="grow"><span className="t">Trésorerie</span><span className="sub">{board.alerts.length ? `${board.alerts.length} alerte${board.alerts.length > 1 ? 's' : ''} dans le tableau de bord` : 'Aucune alerte'}</span></div>
                <div className="end">{cash && <span className={`pill ${cash.tone === 'neutral' ? '' : cash.tone}`}>{cash.status || cash.value}</span>}<span className="chev"><Icon name="chev" size={18} /></span></div>
              </Link>
            )}
            {(t.procedures_unread ?? 0) > 0 && (
              <Link className="row" to="/procedures">
                <div className="grow"><span className="t">Procédures à lire</span><span className="sub">{t.procedures_unread} procédure{(t.procedures_unread ?? 0) > 1 ? 's' : ''} attend{(t.procedures_unread ?? 0) > 1 ? 'ent' : ''} ta lecture</span></div>
                <div className="end"><span className="pill warn">À lire</span><span className="chev"><Icon name="chev" size={18} /></span></div>
              </Link>
            )}
            {(t.issues_open ?? 0) > 0 && (
              <Link className="row" to="/maintenance">
                <div className="grow"><span className="t">Pannes en cours</span><span className="sub">{t.issues_open} panne{(t.issues_open ?? 0) > 1 ? 's' : ''} à traiter</span></div>
                <div className="end">{(t.issues_urgent ?? 0) > 0 && <span className="pill bad">{t.issues_urgent} urgente{(t.issues_urgent ?? 0) > 1 ? 's' : ''}</span>}<span className="chev"><Icon name="chev" size={18} /></span></div>
              </Link>
            )}
            {(t.deadlines_due ?? 0) > 0 && (
              <Link className="row" to="/maintenance">
                <div className="grow"><span className="t">Échéances</span><span className="sub">{t.deadlines_due} échéance{(t.deadlines_due ?? 0) > 1 ? 's' : ''} dans les 30 jours ou dépassée{(t.deadlines_due ?? 0) > 1 ? 's' : ''}</span></div>
                <div className="end"><span className="pill warn">À prévoir</span><span className="chev"><Icon name="chev" size={18} /></span></div>
              </Link>
            )}
            {t.bookings !== undefined && (
              <Link className="row" to="/reservations">
                <div className="grow">
                  <span className="t">Réservations du jour</span>
                  <span className="sub num">{t.bookings === 0 ? 'Aucune pour l\'instant' : `${t.bookings} réservation${t.bookings > 1 ? 's' : ''} · ${t.covers} couvert${(t.covers ?? 0) > 1 ? 's' : ''}`}</span>
                  {pendingCount > 0 && <span className="sub">{pendingCount} demande{pendingCount > 1 ? 's' : ''} de réservation à valider</span>}
                </div>
                <div className="end">{pendingCount > 0 && <span className="pill warn">À valider</span>}<span className="chev"><Icon name="chev" size={18} /></span></div>
              </Link>
            )}
            {closing && (
              <Link className="row" to="/caisse" data-testid="today-caisse">
                <div className="grow">
                  <span className="t">Fermeture de caisse</span>
                  <span className="sub num">{closing.closing?.status === 'closed'
                    ? `Faite${closing.closed_by_name ? ` par ${closing.closed_by_name}` : ''}${closing.closing.z_total !== null ? ` · ${closing.closing.z_total.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })} TTC` : ''}`
                    : closing.closing ? 'Brouillon commencé : à finir en fin de journée' : 'En fin de journée : le Z, le comptage, le terminal CB'}</span>
                </div>
                <div className="end">
                  {closing.closing?.status === 'closed' ? <span className="pill ok">Faite</span> : closing.closing ? <span className="pill warn">Brouillon</span> : null}
                  <span className="chev"><Icon name="chev" size={18} /></span>
                </div>
              </Link>
            )}
            {t.low_stock !== undefined && (t.low_stock > 0 || (t.deliveries ?? 0) > 0) && (
              <Link className="row wrap" to={t.low_stock > 0 ? '/stocks' : '/commandes'}>
                <div className="grow">
                  <span className="t">Stocks et commandes</span>
                  <span className="sub">
                    {[t.low_stock > 0 ? `${t.low_stock} produit${t.low_stock > 1 ? 's' : ''} sous le seuil` : '',
                      (t.deliveries ?? 0) > 0 ? `${t.deliveries} livraison${(t.deliveries ?? 0) > 1 ? 's' : ''} attendue${(t.deliveries ?? 0) > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <div className="end">
                  {t.low_stock > 0 && <span className="pill warn">À commander</span>}
                  <span className="chev"><Icon name="chev" size={18} /></span>
                </div>
              </Link>
            )}
          </div>
        </Section>
      )}

      <div className="cols">
        <Section title="Ma semaine">
          <div className="list">
            <Link className="row" to="/pointeuse">
              <div className="grow">
                <span className="t num">{fmtDur(weekMs)}</span>
                <span className="sub">{me.contract === 'extra' ? 'travaillées cette semaine' : `travaillées sur ${String(me.weekly_hours).replace('.', ',')} h prévues au contrat`}</span>
              </div>
              <span className="chev"><Icon name="chev" size={18} /></span>
            </Link>
          </div>
        </Section>

        <Section title="Mes prochains services" right={<Link className="link" to="/planning">Planning</Link>}>
          <div className="list">
            {next.length === 0 && <p className="empty">{myShifts.error ? 'Le planning arrive bientôt.' : 'Aucun service planifié dans les trois prochaines semaines.'}</p>}
            {next.map((s) => (
              <div className="row" key={s.id}>
                <div className="grow">
                  <span className="t">{fmtDayLong(s.starts_at)}</span>
                  <span className="sub">{s.area || 'Poste non précisé'}</span>
                </div>
                <span className="t num">{fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}</span>
              </div>
            ))}
          </div>
        </Section>

        {manager && (
          <Section title="Équipe du jour" right={<Link className="link" to="/pointeuse">Pointages</Link>}>
            {present.isLoading || teamShifts.isLoading ? <Loading /> : (
              <div className="list">
                <TeamToday shifts={teamShifts.data ?? []} open={present.data ?? []} entries={dayEntries.data ?? []} name={(id) => people.get(id)} />
              </div>
            )}
          </Section>
        )}
      </div>
    </Layout>
  );
}

/** Qui est prévu aujourd'hui et où chacun en est : prévu, en retard, en service, en pause, parti. Plus les présents non prévus. */
const slot = (a: string, b: string, area: string | null) =>
  `${fmtDayLong(a)}, ${fmtTime(a)} – ${fmtTime(b)}${area ? ` (${area})` : ''}`;

/** Mes services ajoutés, modifiés ou retirés : visibles jusqu'à « C'est noté » (un e-mail part aussi, si le gérant l'a activé). */
function PlanningChanged({ changes }: { changes: ShiftChange[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function ack() {
    setBusy(true);
    const { error } = await supabase.rpc('ack_shift_changes');
    setBusy(false);
    if (error) return toast(frError(error), 'bad');
    await qc.invalidateQueries({ queryKey: ['shift-changes'] });
  }
  return (
    <Section title="Ton planning a changé" right={<Link className="link" to="/planning">Planning</Link>}>
      <div className="list" data-testid="planning-changed">
        {changes.map((c) => (
          <div className="row" key={c.id} data-change={c.kind}>
            <div className="grow">
              <span className="t">{c.kind === 'added' ? 'Nouveau service' : c.kind === 'removed' ? 'Service retiré' : 'Service modifié'}</span>
              <span className="sub" style={c.kind === 'removed' ? { textDecoration: 'line-through' } : undefined}>{slot(c.starts_at, c.ends_at, c.area)}</span>
              {c.kind === 'changed' && c.old_starts_at && c.old_ends_at && <span className="sub">Avant : {slot(c.old_starts_at, c.old_ends_at, c.old_area)}</span>}
            </div>
            <div className="end"><span className={`pill ${c.kind === 'removed' ? 'bad' : c.kind === 'added' ? 'ok' : 'warn'}`}>{c.kind === 'added' ? 'Ajouté' : c.kind === 'removed' ? 'Retiré' : 'Modifié'}</span></div>
          </div>
        ))}
      </div>
      <button type="button" className="btn pri" disabled={busy} onClick={() => void ack()}>C'est noté</button>
    </Section>
  );
}

function TeamToday({ shifts, open, entries, name }: { shifts: Shift[]; open: TimeEntry[]; entries: TimeEntry[]; name: (id: string) => { first_name: string; last_name: string } | undefined }) {
  const now = Date.now();
  const planned = new Set(shifts.map((s) => s.profile_id));
  const extra = open.filter((e) => !planned.has(e.profile_id));
  if (shifts.length === 0 && extra.length === 0) return <p className="empty">Personne n'est prévu ni présent pour l'instant.</p>;
  const status = (s: Shift) => {
    const live = open.find((e) => e.profile_id === s.profile_id);
    if (live) return live.time_breaks.some((b) => !b.ended_at) ? <span className="pill warn">En pause</span> : <span className="pill ok">En service depuis {fmtTime(live.clock_in)}</span>;
    const done = entries.find((e) => e.profile_id === s.profile_id && e.clock_out);
    if (done) return <span className="pill">Parti à {fmtTime(done.clock_out!)}</span>;
    if (now > new Date(s.starts_at).getTime() + 10 * 60_000 && now < new Date(s.ends_at).getTime()) return <span className="pill bad">En retard</span>;
    if (now >= new Date(s.ends_at).getTime()) return <span className="pill bad">Pas pointé</span>;
    return <span className="pill">Prévu à {fmtTime(s.starts_at)}</span>;
  };
  return (
    <>
      {shifts.map((s) => (
        <div className="row wrap" key={s.id}>
          <Avatar p={name(s.profile_id)} />
          <div className="grow">
            <span className="t">{fullName(name(s.profile_id))}</span>
            <span className="sub num">{s.area ? `${s.area} · ` : ''}{fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}</span>
          </div>
          {status(s)}
        </div>
      ))}
      {extra.map((e) => (
        <div className="row wrap" key={e.id}>
          <Avatar p={e.profiles} />
          <div className="grow">
            <span className="t">{fullName(e.profiles)}</span>
            <span className="sub">Présent sans service prévu</span>
          </div>
          <span className="pill ok">En service depuis {fmtTime(e.clock_in)}</span>
        </div>
      ))}
    </>
  );
}
