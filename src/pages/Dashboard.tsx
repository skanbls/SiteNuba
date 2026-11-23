import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { LineChart, type RefLine } from '../components/LineChart';
import { Layout, Loading, Section } from '../components/ui';
import { parseBoard, parseHistory, parseSeries, type Kpi, type Tone } from '../lib/dashboard';
import { useDashboard } from '../lib/data';
import { norm } from '../lib/production';
import { frError } from '../lib/supabase';
import { ago, fmtDateShort, fromDayKey } from '../lib/time';

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
      ) : (
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

