import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { LineChart, type RefLine } from '../components/LineChart';
import { Layout, Loading, Section } from '../components/ui';
import { GAP_LIMIT, cashStats, type CashClosing } from '../lib/cash';
import { parseBoard, parseHistory, parseSeries, type Kpi, type Tone } from '../lib/dashboard';
import { useDashboard } from '../lib/data';
import { norm } from '../lib/production';
import { frError, supabase } from '../lib/supabase';
import { addDays, ago, dayKey, fmtDateShort, fmtDayLong, fromDayKey } from '../lib/time';

const euro2 = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

/** Un état : la couleur ne parle jamais seule, le mot et l'icône l'accompagnent. */
function Status({ text, tone }: { text: string; tone: Tone }) {
  return (
    <span className={`pill ${tone === 'neutral' ? '' : tone}`} data-status={text}>
      {tone === 'ok' ? <Icon name="tick" size={13} /> : tone === 'neutral' ? null : <Icon name="alert" size={13} />}
      {text}
    </span>
  );
}

function KpiRow({ k }: { k: Kpi }) {
  const onlyStatus = k.status && k.value === k.status;
  return (
    <div className="row wrap" data-kpi={k.label}>
      <span className="grow">
        <span className="t" style={{ fontWeight: 500 }}>{k.label}</span>
        {k.note && <span className="sub">{k.note}</span>}
      </span>
      <span className="end">
        {!onlyStatus && k.value && <strong className="num">{k.value}</strong>}
        {k.status && <Status text={k.status} tone={k.tone} />}
      </span>
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
function Trend({ now, before, what }: { now: number; before: number; what: string }) {
  const p = pct(now, before);
  if (p === null) return null;
  return <span className={`pill ${p > 0 ? 'ok' : p < 0 ? 'bad' : ''}`} title={`Par rapport ${what} : ${euro2.format(before)}`}>{p > 0 ? '+' : ''}{p} %</span>;
}

/**
 * Les chiffres des fermetures de caisse (migration 0026) : saisis chaque soir par l'équipe, lus ici par le gérant.
 * Le script Google en recopie aussi les totaux de chaque semaine dans « Saisie hebdo » du fichier.
 */
function CashSection() {
  // Journée de service : de 5 h à 5 h.
  const today = dayKey(new Date(Date.now() - 5 * 3600_000));
  const q = useQuery({
    queryKey: ['caisse', 'tableau', today],
    queryFn: async () => {
      const { data, error } = await supabase.from('cash_closings').select('*').gte('day', dayKey(addDays(fromDayKey(today), -70))).order('day');
      if (error) throw error;
      return (data ?? []) as CashClosing[];
    },
  });
  if (q.isLoading) return null;
  if (q.error) {
    return /cash_closings|schema cache|does not exist/i.test(String((q.error as Error).message))
      ? <Section title="Caisse"><p className="note">Les chiffres de la caisse arriveront avec la mise à jour 0026 de la base.</p></Section>
      : <Section title="Caisse"><p className="empty err">{frError(q.error)}</p></Section>;
  }
  const st = cashStats(q.data ?? [], today);
  const m = st.month;
  const parts = [['Carte bancaire', m.card], ['Espèces', m.cash], ['Titres-restaurant', m.meal], ['Chèques et autres', m.other]] as const;
  const paid = parts.reduce((t, [, v]) => t + v, 0);
  const monthName = fromDayKey(today).toLocaleDateString('fr-FR', { month: 'long' });
  return (
    <Section title="Caisse" right={<Link className="link" to="/caisse">Fermetures</Link>}>
      {!st.last ? (
        <p className="note" data-testid="dash-caisse-vide">Pas encore de fermeture de caisse. Chaque soir, l'équipe la fait dans « Fermeture de caisse » : les chiffres arrivent ici aussitôt.</p>
      ) : (
        <div className="form" data-testid="dash-caisse">
          <div className="stats four">
            <div className="stat"><div className="v num">{euro2.format(st.last.z_total ?? 0)}</div><div className="k">{fmtDayLong(fromDayKey(st.last.day))}{st.last.z_covers ? ` · ${st.last.z_covers} couverts` : ''}</div></div>
            <div className="stat"><div className="v num">{euro2.format(st.week.ca)}</div><div className="k">7 derniers jours <Trend now={st.week.ca} before={st.week.previous} what="aux 7 jours d'avant" /></div></div>
            <div className="stat"><div className="v num">{euro2.format(m.ca)}</div><div className="k">{monthName}, {m.days} jour{m.days > 1 ? 's' : ''} <Trend now={m.ca} before={m.previousSamePeriod} what="à la même période du mois dernier" /></div></div>
            <div className="stat"><div className="v num">{m.covers ? euro2.format(m.ca / m.covers) : '–'}</div><div className="k">ticket moyen par couvert ({m.covers} couverts)</div></div>
          </div>
          <LineChart testId="chart-caisse" label="Chiffre d'affaires TTC de chaque jour sur 30 jours" labels={st.series.labels}
            series={[{ name: 'CA TTC du jour', values: st.series.ca, kind: 'main' }]} />
          {paid > 0 && (
            <div className="list">
              {parts.filter(([, v]) => v > 0).map(([label, v]) => (
                <div className="row" key={label} data-pay={label}>
                  <span className="grow t" style={{ fontWeight: 500 }}>{label}</span>
                  <span className="end"><span className="sub num">{Math.round((v / paid) * 100)} %</span><strong className="num">{euro2.format(v)}</strong></span>
                </div>
              ))}
              <div className="row">
                <span className="grow t" style={{ fontWeight: 500 }}>Écarts d'espèces du mois</span>
                <span className="end"><span className={`pill ${Math.abs(m.gaps) > GAP_LIMIT ? 'bad' : 'ok'}`}>{m.gaps > 0 ? '+' : ''}{euro2.format(m.gaps)}</span></span>
              </div>
            </div>
          )}
          <p className="note">Les totaux de chaque semaine terminée vont aussi dans l'onglet « Saisie hebdo » du fichier (CA TTC, dont CB, couverts), sauf là où un chiffre a été écrit à la main.</p>
        </div>
      )}
    </Section>
  );
}

/**
 * Tableau de bord financier de la société, pour les gérants seulement (la base l'impose aussi).
 * Tout vient du fichier Google Sheets « Tableau de bord financier » : alertes, trésorerie,
 * budget d'ouverture, rentabilité, échéances. On le modifie là-bas ; l'appli suit toute seule.
 */
export default function Dashboard() {
  const q = useDashboard(true);
  const src = q.data;
  const tabs = src?.tabs ?? {};
  const board = parseBoard(tabs['Tableau de bord']);
  const t13 = parseSeries(tabs['Tréso 13 semaines'], 'Début de semaine');
  const p12 = parseSeries(tabs['Prévisionnel 12 mois'], 'Mois');
  const history = parseHistory(tabs['Historique KPI']);
  const all = board.sections.flatMap((s) => s.rows);
  const find = (re: RegExp) => all.find((k) => re.test(norm(k.label)));
  const balance = find(/^solde bancaire/);
  const status13 = find(/^statut/);
  const refsOf = (s: ReturnType<typeof parseSeries>): RefLine[] => {
    const green = s?.numbers('Seuil vert')?.find((v) => v != null);
    const red = s?.numbers('Seuil rouge')?.find((v) => v != null);
    return [...(green != null ? [{ name: 'Seuil vert', value: green, tone: 'ok' as const }] : []), ...(red != null ? [{ name: 'Seuil rouge', value: red, tone: 'bad' as const }] : [])];
  };
  const week = t13?.numbers('Solde fin de semaine');
  const month = p12?.numbers('Solde fin de mois');
  const stress = p12?.numbers('Solde fin si');
  const duesTotal = board.dues.reduce((x, d) => x + (d.amount ?? 0), 0);

  return (
    <Layout title="Tableau de bord" right={src?.sheet_url ? <a className="btn sm" href={src.sheet_url} target="_blank" rel="noopener noreferrer">Ouvrir le fichier</a> : undefined}>
      {q.isLoading ? <Loading /> : q.error ? <div className="list"><p className="empty err">{frError(q.error)}</p></div> : !src?.synced_at ? (
        <div className="list">
          <p className="empty">
            Le tableau de bord financier n'est pas encore relié. Dans <Link className="link" to="/reglages">Administration</Link>, rubrique
            « Mercuriales Google Sheets », colle le lien du fichier dans « Tableau de bord financier », puis installe le nouveau script.
          </p>
        </div>
      ) : null}
      {!q.isLoading && !q.error && !src?.synced_at && <CashSection />}
      {src?.synced_at && (
        <>
          {board.subtitle && <p className="note">{board.subtitle}</p>}
          {balance && (
            <div className="dash-hero" data-testid="dash-hero">
              <div className="k">{balance.label}</div>
              <div className="hero-v">{balance.value}</div>
              <div className="dash-hero-sub">
                {balance.note && <span>au {balance.note}</span>}
                {status13 && <span>{status13.label} : <Status text={status13.status || status13.value} tone={status13.tone} /></span>}
              </div>
            </div>
          )}

          {board.alerts.length > 0 && (
            <Section title={`Alertes${board.alertsNote ? ` · ${board.alertsNote}` : ''}`}>
              <div className="list" data-testid="dash-alertes">
                {board.alerts.map((a) => (
                  <div className="row" key={a}>
                    <span className="dash-alert-ico"><Icon name="alert" size={18} /></span>
                    <span className="grow t" style={{ fontWeight: 500 }}>{a}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <CashSection />

          {t13 && week && (
            <Section title="Trésorerie sur 13 semaines">
              <p className="note">Solde prévu en fin de semaine. Touche ou survole le graphique pour lire chaque semaine.</p>
              <LineChart testId="chart-13" label="Solde prévu en fin de semaine sur 13 semaines" labels={t13.labels}
                series={[{ name: 'Solde fin de semaine', values: week, kind: 'main' }]} refs={refsOf(t13)}
                extra={t13.texts('Statut') ? { name: 'État', values: t13.texts('Statut')! } : undefined} />
            </Section>
          )}

          {board.sections.map((s, i) => {
            // Le solde et l'état sont déjà en tête de page.
            const rows = s.rows.filter((k) => k !== balance && k !== status13);
            return rows.length > 0 && (
              <Section key={`${s.title}-${i}`} title={s.title || 'Indicateurs'}>
                <div className="list">{rows.map((k) => <KpiRow key={k.label} k={k} />)}</div>
              </Section>
            );
          })}

          {p12 && month && (
            <Section title="Prévisionnel sur 12 mois">
              <p className="note">Solde prévu en fin de mois, et le même si le chiffre d'affaires de Nuba est 30 % plus bas (test de résistance).</p>
              <LineChart testId="chart-12" label="Solde prévu en fin de mois sur 12 mois" labels={p12.labels}
                series={[{ name: 'Solde fin de mois', values: month, kind: 'main' }, ...(stress ? [{ name: 'Si le CA est 30 % plus bas', values: stress, kind: 'context' as const }] : [])]}
                refs={refsOf(p12)} extra={p12.texts('Statut') ? { name: 'État', values: p12.texts('Statut')! } : undefined} />
            </Section>
          )}

          {board.dues.length > 0 && (
            <Section title={board.duesTitle || 'Prochaines échéances'} right={<span className="num sub">{euro2.format(duesTotal)}</span>}>
              <div className="list" data-testid="dash-echeances">
                {board.dues.map((d, i) => (
                  <div className="row" key={i} data-due={d.label}>
                    <span className="dash-date num">{d.day ? fmtDateShort(fromDayKey(d.day)) : '–'}</span>
                    <span className="grow t" style={{ fontWeight: 500 }}>{d.label}</span>
                    <strong className="num">{d.amount == null ? '–' : euro2.format(d.amount)}</strong>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {history.rows.length > 0 && (
            <details className="chart-table">
              <summary>Historique des lundis ({history.rows.length})</summary>
              <div className="table-scroll">
                <table>
                  <thead><tr>{history.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>{history.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </details>
          )}

          <p className="note" data-testid="dash-sync">
            Reçu du fichier « {src.file_name || 'Tableau de bord financier'} » {ago(src.synced_at)}. Les chiffres se modifient dans Google Sheets ; l'appli suit toute seule.
            Visible par les gérants seulement.
          </p>
        </>
      )}
    </Layout>
  );
}

