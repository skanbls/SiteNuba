import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { PunchSheet } from '../components/PunchSheet';
import { CodeView, useRollingCode } from '../components/RollingCode';
import { Avatar, Chips, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useEntries, useMyOpenEntry, useOpenEntries, useRefresh, useSites, useTeam } from '../lib/data';
import { PUNCH_ERROR, parsePunchLink, punch, punchBreak } from '../lib/punch';
import { useMe } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { PERIOD_LABEL, breakMs, dayKey, fmtDate, fmtDayLong, fmtDur, fmtTime, fromLocalInput, periodRange, toCsv, toLocalInput, workedMs, type Period } from '../lib/time';
import { fullName, type CodeInfo, type Profile, type Site, type TimeEntry } from '../lib/types';

const PERIODS: [Period, string][] = [['week', PERIOD_LABEL.week], ['month', PERIOD_LABEL.month], ['lastMonth', PERIOD_LABEL.lastMonth]];

/** Fait repasser l'écran à intervalle régulier pour que les durées en cours avancent. */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export default function Pointeuse() {
  const me = useMe();
  const manager = me.role !== 'equipier';
  const [tab, setTab] = useState<'moi' | 'equipe'>('moi');
  return (
    <Layout
      title="Pointeuse"
      right={manager && (
        <div className="seg" role="group" aria-label="Vue">
          <button type="button" aria-pressed={tab === 'moi'} onClick={() => setTab('moi')}>Moi</button>
          <button type="button" aria-pressed={tab === 'equipe'} onClick={() => setTab('equipe')}>Équipe</button>
        </div>
      )}
    >
      {tab === 'moi' ? <Mine me={me} /> : <TeamView me={me} />}
    </Layout>
  );
}

/* ---------- Mon pointage ---------- */
function Mine({ me }: { me: Profile }) {
  const toast = useToast();
  const refresh = useRefresh();
  const now = useNow(20_000);
  const open = useMyOpenEntry(me.id);
  const [sheet, setSheet] = useState<'in' | 'out' | null>(null);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState<Period>('week');
  const range = useMemo(() => periodRange(period), [period]);
  const entries = useEntries(range.from, range.to, me.id);
  const e = open.data;
  const pause = e?.time_breaks.find((b) => !b.ended_at);
  const total = (entries.data ?? []).reduce((s, x) => s + workedMs(x, now), 0);
  const close = useCallback(() => setSheet(null), []);

  async function brk(action: 'start' | 'end') {
    setBusy(true);
    try {
      const r = await punchBreak(action);
      if (!r.ok) toast(PUNCH_ERROR[r.error], 'bad');
      else toast(action === 'start' ? 'Pause commencée' : 'Service repris');
      await refresh('entries');
    } catch (x) {
      toast(frError(x), 'bad');
    }
    setBusy(false);
  }

  return (
    <div className="cols">
      <div className="stack">
        <div className="panel">
          {open.isLoading ? <Spinner /> : !e ? (
            <>
              <span className="pill">Hors service</span>
              <p className="big">Pas pointé</p>
              <p className="sub">Scanne le QR code de la borne pour pointer ton arrivée.</p>
              <div className="acts">
                <button type="button" className="btn pri" onClick={() => setSheet('in')}><Icon name="qr" />Pointer mon arrivée</button>
              </div>
            </>
          ) : pause ? (
            <>
              <span className="pill warn">En pause</span>
              <p className="big">{fmtTime(pause.started_at)}</p>
              <p className="sub">Pause commencée. Elle est déduite de ton temps de service.</p>
              <div className="acts">
                <button type="button" className="btn pri" disabled={busy} onClick={() => void brk('end')}>Reprendre le service</button>
              </div>
            </>
          ) : (
            <>
              <span className="pill ok">En service</span>
              <p className="big">{fmtDur(workedMs(e, now))}</p>
              <p className="sub">Arrivée à {fmtTime(e.clock_in)}{e.sites ? ` · ${e.sites.name}` : ''}{breakMs(e, now) > 0 ? ` · pause ${Math.round(breakMs(e, now) / 60000)} min` : ''}</p>
              <div className="acts">
                <button type="button" className="btn" disabled={busy} onClick={() => void brk('start')}>Commencer ma pause</button>
                <button type="button" className="btn pri" onClick={() => setSheet('out')}><Icon name="qr" />Pointer mon départ</button>
              </div>
            </>
          )}
        </div>
      </div>

      <Section title="Mes heures">
        <Chips value={period} options={PERIODS} onChange={setPeriod} label="Période" />
        {entries.isLoading ? <Loading /> : (
          <div className="list">
            {(entries.data ?? []).length === 0 && <p className="empty">Aucun pointage sur cette période.</p>}
            {(entries.data ?? []).map((x) => <EntryRow key={x.id} e={x} now={now} />)}
            <div className="row">
              <div className="grow">
                <span className="t">Total</span>
                <span className="sub">{me.contract === 'extra' ? 'Extra, payé à l\'heure' : `Contrat de ${String(me.weekly_hours).replace('.', ',')} h par semaine`}</span>
              </div>
              <span className="t num">{fmtDur(total)}</span>
            </div>
          </div>
        )}
      </Section>

      {sheet && <PunchSheet action={sheet} onClose={close} />}
    </div>
  );
}

function EntryRow({ e, now, withName, onClick }: { e: TimeEntry; now: number; withName?: boolean; onClick?: () => void }) {
  const body = (
    <>
      {withName && <Avatar p={e.profiles} />}
      <div className="grow">
        <span className="t">{withName ? fullName(e.profiles) : fmtDayLong(e.clock_in)}</span>
        <span className="sub num">
          {fmtTime(e.clock_in)} – {e.clock_out ? fmtTime(e.clock_out) : 'en cours'}
          {breakMs(e, now) > 0 ? ` · pause ${Math.round(breakMs(e, now) / 60000)} min` : ''}
          {e.sites ? ` · ${e.sites.name}` : ''}
        </span>
        {e.note && <span className="sub">{e.note}</span>}
      </div>
      <div className="end">
        {e.needs_review ? <span className="pill bad">À corriger</span> : e.source === 'manuel' ? <span className="pill">Saisie manuelle</span> : null}
        <span className="t num">{fmtDur(workedMs(e, now))}</span>
      </div>
    </>
  );
  return onClick ? <button type="button" className="row wrap" onClick={onClick}>{body}</button> : <div className="row wrap">{body}</div>;
}

/* ---------- Pointages de l'équipe (gérant et responsables) ---------- */
function TeamView({ me }: { me: Profile }) {
  const gerant = me.role === 'gerant';
  const now = useNow(30_000);
  const team = useTeam();
  const sites = useSites();
  const present = useOpenEntries(true);
  const [period, setPeriod] = useState<Period>('month');
  const [who, setWho] = useState('');
  const range = useMemo(() => periodRange(period), [period]);
  const entries = useEntries(range.from, range.to, who || undefined);
  const [edit, setEdit] = useState<TimeEntry | 'new' | null>(null);
  const [showCode, setShowCode] = useState(false);
  const closeEdit = useCallback(() => setEdit(null), []);
  const closeCode = useCallback(() => setShowCode(false), []);

  const list = entries.data ?? [];
  const totals = useMemo(() => {
    const m = new Map<string, { name: string; ms: number; n: number; flags: number }>();
    for (const e of list) {
      const t = m.get(e.profile_id) ?? { name: fullName(e.profiles), ms: 0, n: 0, flags: 0 };
      t.ms += workedMs(e, now);
      t.n += 1;
      if (e.needs_review) t.flags += 1;
      m.set(e.profile_id, t);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }, [list, now]);

  const days = useMemo(() => {
    const g: { key: string; label: string; items: TimeEntry[] }[] = [];
    for (const e of list) {
      const k = dayKey(e.clock_in);
      const last = g[g.length - 1];
      if (last && last.key === k) last.items.push(e);
      else g.push({ key: k, label: fmtDayLong(e.clock_in), items: [e] });
    }
    return g;
  }, [list]);

  function exportCsv() {
    const rows: (string | number)[][] = [['Nom', 'Date', 'Arrivée', 'Départ', 'Pause (min)', 'Temps travaillé', 'Heures (décimal)', 'Lieu', 'Saisie', 'Note']];
    const sorted = [...list].sort((a, b) => fullName(a.profiles).localeCompare(fullName(b.profiles), 'fr') || a.clock_in.localeCompare(b.clock_in));
    for (const e of sorted) {
      const done = !!e.clock_out;
      rows.push([
        fullName(e.profiles), fmtDate(e.clock_in), fmtTime(e.clock_in), done ? fmtTime(e.clock_out!) : 'en cours',
        Math.round(breakMs(e, now) / 60000), done ? fmtDur(workedMs(e)) : '', done ? Math.round(workedMs(e) / 36000) / 100 : '',
        e.sites?.name ?? '', e.source === 'qr' ? 'QR code' : 'Manuelle', (e.needs_review ? 'À corriger. ' : '') + e.note,
      ]);
    }
    rows.push([], ['Total par personne', '', '', '', '', 'Temps travaillé', 'Heures (décimal)']);
    for (const t of totals) rows.push([t.name, '', '', '', '', fmtDur(t.ms), Math.round(t.ms / 36000) / 100]);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
    a.download = `pointages-${dayKey(range.from)}-au-${dayKey(new Date(range.to.getTime() - 86_400_000))}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  return (
    <>
      <div className="acts">
        <button type="button" className="btn" onClick={() => setShowCode(true)}><Icon name="qr" />Afficher le QR code</button>
        {gerant && <button type="button" className="btn" onClick={() => setEdit('new')}><Icon name="plus" />Ajouter un pointage</button>}
        {gerant && <button type="button" className="btn" onClick={exportCsv} disabled={!list.length}><Icon name="down" />Exporter pour le comptable</button>}
      </div>

      <div className="cols">
        <div className="stack">
          <Section title="Présents maintenant">
            {present.isLoading ? <Loading /> : (
              <div className="list">
                {(present.data ?? []).length === 0 && <p className="empty">Personne n'a pointé pour l'instant.</p>}
                {(present.data ?? []).map((x) => (
                  <EntryRow key={x.id} e={x} now={now} withName onClick={gerant ? () => setEdit(x) : undefined} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Total par personne">
            {entries.isLoading ? <Loading /> : (
              <div className="list">
                {totals.length === 0 && <p className="empty">Aucun pointage sur cette période.</p>}
                {totals.map((t) => (
                  <div className="row" key={t.name}>
                    <div className="grow">
                      <span className="t">{t.name}</span>
                      <span className="sub">{t.n} pointage{t.n > 1 ? 's' : ''}</span>
                    </div>
                    <div className="end">
                      {t.flags > 0 && <span className="pill bad">{t.flags} à corriger</span>}
                      <span className="t num">{fmtDur(t.ms)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        <Section title="Pointages">
          <Chips value={period} options={PERIODS} onChange={setPeriod} label="Période" />
          <Field label="Personne">
            <select className="in" id="filter-who" value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Toute l'équipe</option>
              {(team.data ?? []).map((p) => (<option key={p.id} value={p.id}>{fullName(p)}</option>))}
            </select>
          </Field>
          {entries.isLoading ? <Loading /> : (
            <div className="list">
              {days.length === 0 && <p className="empty">Aucun pointage sur cette période.</p>}
              {days.map((d) => (
                <div key={d.key}>
                  <p className="day-h">{d.label}</p>
                  {d.items.map((x) => (
                    <EntryRow key={x.id} e={x} now={now} withName onClick={gerant ? () => setEdit(x) : undefined} />
                  ))}
                </div>
              ))}
            </div>
          )}
          {gerant && <p className="note">Touche un pointage pour le corriger. Chaque correction est enregistrée avec ton nom, la date et les anciennes valeurs.</p>}
        </Section>
      </div>

      {edit && <EntrySheet entry={edit} team={team.data ?? []} sites={sites.data ?? []} onClose={closeEdit} />}
      {showCode && <ShowCodeSheet sites={(sites.data ?? []).filter((s) => s.active)} onClose={closeCode} />}
    </>
  );
}

/* ---------- Correction ou ajout par le gérant ---------- */
function EntrySheet({ entry, team, sites, onClose }: { entry: TimeEntry | 'new'; team: Profile[]; sites: Site[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = entry === 'new' ? null : entry;
  const [who, setWho] = useState(old?.profile_id ?? '');
  const [site, setSite] = useState(old ? old.site_id ?? '' : sites.find((s) => s.active)?.id ?? '');
  const [cin, setCin] = useState(toLocalInput(old?.clock_in ?? null));
  const [cout, setCout] = useState(toLocalInput(old?.clock_out ?? null));
  const [brk, setBrk] = useState(old ? String(Math.round(breakMs(old) / 60000)) : '0');
  const [note, setNote] = useState(old?.note ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!who) return setErr('Choisis la personne.');
    if (!cin) return setErr("Indique l'heure d'arrivée.");
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('save_time_entry', {
      p_id: old?.id ?? null, p_profile: who, p_site: site || null,
      p_in: fromLocalInput(cin), p_out: fromLocalInput(cout), p_break_minutes: Number(brk) || 0, p_note: note,
    });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('entries');
    toast(old ? 'Pointage corrigé' : 'Pointage ajouté');
    onClose();
  }

  async function remove() {
    if (!old) return;
    setBusy(true);
    const { error } = await supabase.from('time_entries').delete().eq('id', old.id);
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('entries');
    toast('Pointage supprimé');
    onClose();
  }

  return (
    <Sheet title={old ? 'Corriger le pointage' : 'Ajouter un pointage'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Personne">
          <select className="in" id="entry-who" value={who} onChange={(e) => setWho(e.target.value)} disabled={!!old} required>
            <option value="">Choisir</option>
            {team.filter((p) => p.active || p.id === who).map((p) => (<option key={p.id} value={p.id}>{fullName(p)}</option>))}
          </select>
        </Field>
        <div className="two">
          <Field label="Arrivée">
            <input className="in" id="entry-in" type="datetime-local" value={cin} onChange={(e) => setCin(e.target.value)} required />
          </Field>
          <Field label="Départ" hint="Vide si la personne est encore en service.">
            <input className="in" id="entry-out" type="datetime-local" value={cout} onChange={(e) => setCout(e.target.value)} />
          </Field>
        </div>
        <div className="two">
          <Field label="Pause (minutes)">
            <input className="in" id="entry-break" type="number" min={0} max={600} inputMode="numeric" value={brk} onChange={(e) => setBrk(e.target.value)} />
          </Field>
          <Field label="Lieu">
            <select className="in" id="entry-site" value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">Non précisé</option>
              {sites.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
            </select>
          </Field>
        </div>
        <Field label="Note" hint="Par exemple la raison de la correction.">
          <input className="in" id="entry-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && (confirm ? (
          <div className="acts">
            <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
            <button type="button" className="btn no" disabled={busy} onClick={() => void remove()}>Supprimer définitivement</button>
          </div>
        ) : (
          <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Supprimer ce pointage</button>
        ))}
      </form>
    </Sheet>
  );
}

/* ---------- QR code sur le téléphone d'un responsable (prestation extérieure) ---------- */
function ShowCodeSheet({ sites, onClose }: { sites: Site[]; onClose: () => void }) {
  const [site, setSite] = useState(sites[0]?.id ?? '');
  return (
    <Sheet title="QR code de pointage" onClose={onClose}>
      {sites.length > 1 && (
        <Field label="Lieu">
          <select className="in" id="code-site" value={site} onChange={(e) => setSite(e.target.value)}>
            {sites.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
        </Field>
      )}
      {site ? <LiveCode key={site} site={site} /> : <p className="empty">Aucun lieu de pointage actif.</p>}
      <p className="note">Montre cet écran à l'équipe quand il n'y a pas de borne sur place, par exemple en prestation extérieure.</p>
    </Sheet>
  );
}

function LiveCode({ site }: { site: string }) {
  const fetcher = useCallback(async () => {
    const { data, error } = await supabase.rpc('site_code', { p_site: site });
    if (error) throw error;
    return data as CodeInfo | null;
  }, [site]);
  const { info, left, state } = useRollingCode(fetcher);
  return (
    <div className="panel">
      {info && <p className="t">{info.site_name}</p>}
      <CodeView info={info} left={left} />
      {state === 'offline' && <p className="pill bad">Connexion perdue, nouvel essai en cours</p>}
    </div>
  );
}

/* ---------- Arrivée par le lien du QR code (scanné avec l'appareil photo du téléphone) ---------- */
export function PunchFromLink() {
  const me = useMe();
  const toast = useToast();
  const refresh = useRefresh();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const link = parsePunchLink(`?${params.toString()}`);
  const open = useMyOpenEntry(me.id);
  const sites = useSites();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (!link) return <Navigate to="/pointeuse" replace />;
  const action = open.data ? 'out' : 'in';
  const place = sites.data?.find((s) => s.id === link.site)?.name;

  async function go() {
    if (!link) return;
    setBusy(true);
    setErr('');
    try {
      const r = await punch(link.site, link.code, action);
      await refresh('entries');
      if (r.ok) {
        toast(`${action === 'in' ? 'Arrivée pointée' : 'Départ pointé'} à ${fmtTime(new Date())}`);
        nav('/pointeuse', { replace: true });
        return;
      }
      setErr(PUNCH_ERROR[r.error] ?? r.error);
    } catch (x) {
      setErr(frError(x));
    }
    setBusy(false);
  }

  return (
    <Layout title="Pointer">
      <div className="panel">
        {open.isLoading ? <Spinner /> : (
          <>
            <span className="pill info">{place ?? 'Lieu de pointage'}</span>
            <p className="big">{fmtTime(new Date())}</p>
            <div className="acts">
              <button type="button" className="btn pri" disabled={busy} onClick={() => void go()}>
                {busy ? <Spinner /> : action === 'in' ? 'Pointer mon arrivée' : 'Pointer mon départ'}
              </button>
            </div>
            {err && <p className="err" role="alert">{err}</p>}
            <p className="note">Le code scanné reste valable moins d'une minute. S'il est refusé, rescanne le QR code de la borne.</p>
          </>
        )}
      </div>
    </Layout>
  );
}
