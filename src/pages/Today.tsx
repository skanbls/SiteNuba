import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Avatar, Layout, Loading, Section } from '../components/ui';
import { useEntries, useMyOpenEntry, useOpenEntries } from '../lib/data';
import { useMe } from '../lib/session';
import { fmtDayLong, fmtDur, fmtTime, periodRange, workedMs } from '../lib/time';
import { fullName } from '../lib/types';

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

        {manager && (
          <Section title="Présents maintenant" right={<Link className="link" to="/pointeuse">Pointages</Link>}>
            {present.isLoading ? <Loading /> : (
              <div className="list">
                {(present.data ?? []).length === 0 && <p className="empty">Personne n'a pointé pour l'instant.</p>}
                {(present.data ?? []).map((x) => (
                  <div className="row" key={x.id}>
                    <Avatar p={x.profiles} />
                    <div className="grow">
                      <span className="t">{fullName(x.profiles)}</span>
                      <span className="sub">{x.sites?.name ?? 'Lieu non précisé'} · depuis {fmtTime(x.clock_in)}</span>
                    </div>
                    {x.time_breaks.some((b) => !b.ended_at) ? <span className="pill warn">En pause</span> : <span className="pill ok">En service</span>}
                  </div>
                ))}
              </div>
            )}
          </Section>
        )}
      </div>
    </Layout>
  );
}
