import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { TeamDocumentsView } from '../components/Documents';
import { Icon } from '../components/Icon';
import { BrandHead } from '../components/Logo';
import { Chips, Field, Layout, Loading, Section } from '../components/ui';
import { useAccountingSettings } from '../lib/data';
import { downloadCsv, hoursRows, totalsOf } from '../lib/hours';
import { absenceText, absencesOf, recapRows, weeklyMs, type ReportAbsence } from '../lib/recap';
import { useSession } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { addDays, dayKey, fmtDate, fmtDur, fmtTime, periodRange, workedMs } from '../lib/time';
import { CONTRACT_LABEL, REASON_LABEL, type Contract, type TimeEntry } from '../lib/types';

interface Person { id: string; first_name: string; last_name: string; contract: Contract; weekly_hours: number; active: boolean }
interface Report { people: Person[]; entries: TimeEntry[]; absences?: ReportAbsence[] }
type Tab = 'recap' | 'documents' | 'caisse';
type Choice = 'month' | 'lastMonth' | 'other';

const decimal = (ms: number) => (Math.round(ms / 36000) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2 });

/**
 * Heures travaillées de l'équipe, pour la comptable (et le gérant, qui voit la même chose).
 * Les données viennent de hours_report : noms, contrats, pointages et pauses, sans notes ni coordonnées.
 */
function HoursBody() {
  const [choice, setChoice] = useState<Choice>('lastMonth');
  const def = periodRange('lastMonth');
  const [from, setFrom] = useState(dayKey(def.from));
  const [to, setTo] = useState(dayKey(addDays(def.to, -1)));
  const range = useMemo(() => {
    if (choice === 'other') return { from, to };
    const r = periodRange(choice);
    return { from: dayKey(r.from), to: dayKey(addDays(r.to, -1)) };
  }, [choice, from, to]);
  const report = useQuery({
    queryKey: ['hours', range.from, range.to],
    enabled: !!range.from && !!range.to && range.from <= range.to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('hours_report', { p_from: range.from, p_to: range.to });
      if (error) throw error;
      return data as Report;
    },
  });
  const entries = report.data?.entries ?? [];
  const absences = report.data?.absences ?? [];
  const people = new Map((report.data?.people ?? []).map((p) => [p.id, p]));
  const now = Date.now();
  const totals = totalsOf(entries, now, true);
  // Les personnes absentes tout le mois ont aussi leur ligne.
  for (const p of report.data?.people ?? []) {
    if (!totals.some((t) => t.id === p.id) && absences.some((a) => a.profile_id === p.id)) {
      totals.push({ id: p.id, name: `${p.first_name} ${p.last_name}`, ms: 0, n: 0, flags: 0, days: 0 });
    }
  }
  totals.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const open = entries.filter((e) => !e.clock_out).length;
  const all = totals.reduce((s, t) => s + t.ms, 0);

  return (
    <>
      <Chips value={choice} options={[['month', 'Ce mois'], ['lastMonth', 'Mois dernier'], ['other', 'Autre période']]} onChange={setChoice} label="Période" />
      {choice === 'other' && (
        <div className="two">
          <Field label="Du"><input className="in" id="h-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Au"><input className="in" id="h-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      )}
      {report.isLoading ? <Loading /> : report.error ? <div className="list"><p className="empty err">{frError(report.error)}</p></div> : (
        <>
          <Section title={`Du ${fmtDate(range.from + 'T12:00')} au ${fmtDate(range.to + 'T12:00')}`}>
            <div className="list">
              {totals.length === 0 && <p className="empty">Aucune heure pointée ni absence sur cette période.</p>}
              {totals.map((t) => {
                const p = people.get(t.id);
                const abs = absencesOf(absences, t.id, range.from, range.to);
                const weeks = [...weeklyMs(entries, t.id).entries()].sort();
                return (
                  <details key={t.id} className="row-details" data-person={t.name}>
                    <summary className="row wrap">
                      <span className="grow">
                        <span className="t">{t.name}</span>
                        <span className="sub">{[p ? CONTRACT_LABEL[p.contract] : null, p && p.contract !== 'extra' ? `${String(p.weekly_hours).replace('.', ',')} h par semaine au contrat` : null, `${t.days} jour${t.days > 1 ? 's' : ''} travaillé${t.days > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="end">
                        {abs.length > 0 && <span className="pill info">{abs.length} motif{abs.length > 1 ? 's' : ''} d'absence</span>}
                        {t.flags > 0 && <span className="pill warn">{t.flags} à vérifier</span>}
                        <strong className="num">{fmtDur(t.ms)}</strong>
                      </span>
                    </summary>
                    {abs.length > 0 && (
                      <div className="list" style={{ margin: '0 14px 10px' }} data-absences={t.name}>
                        {abs.map((a) => (
                          <div className="row" key={a.reason}>
                            <span className="grow"><span className="t">{REASON_LABEL[a.reason]}</span><span className="sub">{absenceText(a)}{a.document ? ' · justificatif reçu' : ''}</span></span>
                          </div>
                        ))}
                      </div>
                    )}
                    {weeks.length > 0 && (
                      <p className="note" style={{ margin: '0 14px 10px' }}>
                        Par semaine : {weeks.map(([w, ms]) => `semaine du ${w.slice(8)}/${w.slice(5, 7)} : ${fmtDur(ms)}`).join(' · ')}
                      </p>
                    )}
                    <div className="list" style={{ margin: '0 14px 12px' }}>
                      {entries.filter((e) => e.profile_id === t.id && e.clock_out).map((e) => (
                        <div className="row" key={e.id}>
                          <span className="grow">
                            <span className="t">{fmtDate(e.clock_in)}</span>
                            <span className="sub">{fmtTime(e.clock_in)} – {fmtTime(e.clock_out!)}{e.sites?.name ? ` · ${e.sites.name}` : ''}{e.needs_review ? ' · à vérifier' : ''}</span>
                          </span>
                          <span className="end num">{fmtDur(workedMs(e))}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </Section>
          {totals.length > 0 && (
            <p className="note">
              Total de l'équipe : <strong>{fmtDur(all)}</strong> ({decimal(all)} heures). Pauses déduites.
              {open > 0 ? ` ${open} présence${open > 1 ? 's' : ''} en cours, sans départ pointé, ne ${open > 1 ? 'sont' : 'est'} pas comptée${open > 1 ? 's' : ''}.` : ''}
              {totals.some((t) => t.flags) ? ' « À vérifier » : départ oublié, clos automatiquement ; le gérant le corrige.' : ''}
            </p>
          )}
          <button type="button" className="btn pri" disabled={!totals.length}
            onClick={() => downloadCsv(recapRows(report.data?.people ?? [], entries, absences, range.from, range.to, (c) => CONTRACT_LABEL[c as Contract] ?? c), `recap-nuba-${range.from}-au-${range.to}.csv`)}>
            <Icon name="down" />Télécharger le récap (Excel)
          </button>
          <button type="button" className="btn" disabled={!entries.length}
            onClick={() => downloadCsv(hoursRows(entries, now), `heures-nuba-${range.from}-au-${range.to}.csv`)}>
            <Icon name="down" />Détail des pointages (Excel)
          </button>
          <p className="note">Le récap donne, pour chacun : heures travaillées, jours travaillés, heures par semaine et absences par motif (jours calendaires et ouvrables, dates). Absences acceptées seulement.</p>
        </>
      )}
    </>
  );
}

/** Caisse : lien vers Zelty en attendant que l'appli lise elle-même les Z de caisse. */
function Cash() {
  const q = useAccountingSettings(true);
  const url = q.data?.zelty_url ?? '';
  return (
    <>
      <div className="list">
        <div className="row wrap" data-testid="caisse">
          <span className="grow">
            <span className="t">Caisse Zelty</span>
            <span className="sub">{url ? 'Le tableau de bord de la caisse : Z de chaque jour, encaissements, TVA. Connecte-toi avec ton accès Zelty.' : "Le gérant n'a pas encore ajouté le lien de la caisse."}</span>
          </span>
          {url && <span className="end"><a className="btn sm pri" href={url} target="_blank" rel="noopener noreferrer">Ouvrir Zelty</a></span>}
        </div>
      </div>
      <p className="note">Bientôt ici : les Z de caisse de chaque jour, les encaissements par moyen de paiement et la TVA, lus directement dans Zelty, dès que l'abonnement et son accès seront activés.</p>
    </>
  );
}

const TABS: [Tab, string][] = [['recap', 'Récap du mois'], ['documents', 'Documents'], ['caisse', 'Caisse']];

function AccountantTabs() {
  const [tab, setTab] = useState<Tab>('recap');
  return (
    <>
      <Chips value={tab} options={TABS} onChange={setTab} label="Rubrique" />
      {tab === 'recap' ? <HoursBody /> : tab === 'documents' ? <TeamDocumentsView /> : <Cash />}
    </>
  );
}

/** Espace de la comptable : le récap du mois (heures et absences), les documents de l'équipe, la caisse. */
export function AccountantHome() {
  const { accountant, signOut } = useSession();
  return (
    <div className="full">
      <div className="card wide" style={{ maxWidth: 760 }}>
        <BrandHead />
        <div>
          <h1>Espace comptable</h1>
          <p className="sub">Accès comptable{accountant?.name ? ` · ${accountant.name}` : ''} · {accountant?.email}</p>
        </div>
        <AccountantTabs />
        <button type="button" className="btn" onClick={() => void signOut()}>Se déconnecter</button>
      </div>
    </div>
  );
}

/** Le gérant voit exactement ce que voit la comptable. */
export default function HoursPreview() {
  return (
    <Layout title="Vue de la comptable">
      <p className="note">C'est exactement ce que voit la comptable avec son accès : le récap du mois (heures et absences), les documents de l'équipe et la caisse. Rien d'autre.</p>
      <AccountantTabs />
    </Layout>
  );
}
