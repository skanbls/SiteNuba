import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Avatar, Layout, Loading, Section } from '../components/ui';
import { useEntries, useMyOpenEntry, useOpenEntries, useShifts, useTeam } from '../lib/data';
import { useMe } from '../lib/session';
import { addDays, dayKey, fmtDayLong, fmtDur, fmtTime, periodRange, workedMs } from '../lib/time';
import { fullName, type Shift, type TimeEntry } from '../lib/types';

const startOfToday = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/** Accueil : où j'en suis, et pour les responsables, qui est là. */
export default function Today() {
  const me = useMe();
  const manager = me.role !== 'equipier';
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
