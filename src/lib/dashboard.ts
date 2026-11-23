/**
 * Tableau de bord financier de la société, reçu du fichier Google Sheets du gérant.
 * Le script envoie chaque onglet tel qu'il s'affiche (« d ») et ses valeurs brutes (« v ») ;
 * l'appli le relit ici, sans dépendre de la place exacte des cases :
 *  - Tableau de bord : des rubriques (une ligne avec seulement un titre), puis des lignes
 *    « libellé | valeur | état ou remarque » ; une rubrique « Alertes » faite de phrases ;
 *    un tableau d'échéances sous une ligne « Date | Libellé | Montant ».
 *  - Tréso 13 semaines, Prévisionnel 12 mois : une ligne d'en-têtes (« Début de semaine », « Mois »)
 *    puis une ligne par grandeur, retrouvée par son libellé.
 *  - Historique KPI : un tableau, une ligne par lundi.
 */
import { norm } from './production';

export interface Grid { d: string[][]; v: unknown[][] }
export type Tabs = Record<string, Grid>;
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface Kpi { label: string; value: string; note: string; status: string; tone: Tone }
export interface KpiSection { title: string; rows: Kpi[] }
export interface Due { day: string | null; label: string; amount: number | null }
export interface Board {
  title: string;
  subtitle: string;
  sections: KpiSection[];
  alerts: string[];
  alertsNote: string;
  duesTitle: string;
  dues: Due[];
}

const cell = (g: Grid, r: number, c: number) => (g.d[r]?.[c] ?? '').toString().trim();
const filled = (g: Grid, r: number) => [0, 1, 2].some((c) => cell(g, r, c) !== '');

/** Un état écrit en capitales dans la feuille : OK, ORANGE, DÉPASSEMENT, À CORRIGER… */
export const isStatus = (s: string) => s !== '' && s === s.toUpperCase() && /\p{Lu}/u.test(s) && !/[0-9€%]/.test(s);

/** Couleur d'un état : vert, orange ou rouge. */
export function tone(s: string): Tone {
  const t = norm(s);
  if (!t) return 'neutral';
  if (/negatif|rouge|depassement|retard|decouvert|critique/.test(t)) return 'bad';
  if (/orange|a corriger|au-dessus|attention|a surveiller|insuffisant/.test(t)) return 'warn';
  if (/^vert$|^ok$|en avance|a jour|^atteint/.test(t)) return 'ok';
  return 'neutral';
}

/** Montant écrit à la française (« -1 579,50 € ») ou nombre brut. */
export function amountOf(v: unknown, shown = ''): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = (typeof v === 'string' && v.trim() ? v : shown).replace(/[\s  €]/g, '').replace(/[−–]/g, '-').replace(',', '.');
  if (!/^[+-]?\d+(\.\d+)?%?$/.test(t)) return null;
  const n = Number(t.replace('%', ''));
  return t.endsWith('%') ? n / 100 : n;
}

/** Date d'une case : AAAA-MM-JJ, numéro de série de Google Sheets, ou jj/mm/aaaa. */
export function dayOf(v: unknown, shown = ''): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const serial = typeof v === 'number' ? v : /^\d{5}$/.test(shown.trim()) ? Number(shown) : NaN;
  if (serial > 30000 && serial < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(shown.trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

const isDueHeader = (g: Grid, r: number) => norm(cell(g, r, 0)) === 'date' && cell(g, r, 1) !== '';

export function parseBoard(g: Grid | undefined): Board {
  const b: Board = { title: '', subtitle: '', sections: [], alerts: [], alertsNote: '', duesTitle: '', dues: [] };
  if (!g) return b;
  const rows = g.d.length;
  const next = (r: number) => {
    for (let k = r + 1; k < rows; k++) if (filled(g, k)) return k;
    return -1;
  };
  let mode: 'kpi' | 'alerts' | 'dues' = 'kpi';
  let section: KpiSection | null = null;
  let start = 0;
  if (cell(g, 0, 0) && !cell(g, 0, 1)) { b.title = cell(g, 0, 0); start = 1; }
  if (start === 1 && cell(g, 1, 0) && !cell(g, 1, 1)) { b.subtitle = cell(g, 1, 0); start = 2; }

  for (let r = start; r < rows; r++) {
    if (!filled(g, r)) continue;
    const [a, v, c] = [cell(g, r, 0), cell(g, r, 1), cell(g, r, 2)];
    if (isDueHeader(g, r)) { mode = 'dues'; continue; }
    if (mode === 'dues' && v) {
      b.dues.push({ day: dayOf(g.v[r]?.[0], a), label: v, amount: amountOf(g.v[r]?.[2], c) });
      continue;
    }
    if (a && !v && /^alerte/.test(norm(a))) {
      mode = 'alerts';
      b.alertsNote = c;
      section = null;
      continue;
    }
    if (a && !v && !c) {
      const n = next(r);
      if (n !== -1 && isDueHeader(g, n)) { b.duesTitle = a; section = null; continue; }
      if (mode === 'alerts') { b.alerts.push(a); continue; }
      section = { title: a, rows: [] };
      b.sections.push(section);
      mode = 'kpi';
      continue;
    }
    if (mode === 'alerts') { b.alerts.push([a, v, c].filter(Boolean).join(' ')); continue; }
    if (!section) { section = { title: '', rows: [] }; b.sections.push(section); }
    const status = isStatus(c) ? c : isStatus(v) ? v : '';
    // « Seuil vert / seuil rouge | 13 659 € | 6 304 € » : deux valeurs pour un libellé double.
    const pair = !status && a.includes(' / ') && c !== '' && amountOf(g.v[r]?.[2], c) != null;
    section.rows.push({ label: a, value: pair ? `${v} / ${c}` : v, note: status === c || pair ? '' : c, status, tone: tone(status) });
  }
  b.dues.sort((x, y) => (x.day ?? '9999').localeCompare(y.day ?? '9999'));
  return b;
}

/* ---------- Séries : Tréso 13 semaines, Prévisionnel 12 mois ---------- */
export interface Series {
  /** Étiquettes des colonnes (« 22/11 », « déc. 2026 »). */
  labels: string[];
  /** Valeurs d'une ligne, retrouvée par le début de son libellé. */
  numbers: (prefix: string) => (number | null)[] | null;
  /** Texte affiché d'une ligne. */
  texts: (prefix: string) => string[] | null;
}

export function parseSeries(g: Grid | undefined, header: string): Series | null {
  if (!g) return null;
  const find = (prefix: string) => g.d.findIndex((row) => norm(row?.[0] ?? '').startsWith(norm(prefix)));
  const h = find(header);
  if (h === -1) return null;
  const from = (g.d[h] ?? []).findIndex((x, i) => i > 0 && String(x).trim() !== '');
  if (from === -1) return null;
  const labels = g.d[h].slice(from).map((x) => String(x).trim());
  const width = labels.length;
  return {
    labels,
    numbers: (prefix) => {
      const r = find(prefix);
      if (r === -1) return null;
      return Array.from({ length: width }, (_, i) => amountOf(g.v[r]?.[from + i], cell(g, r, from + i)));
    },
    texts: (prefix) => {
      const r = find(prefix);
      return r === -1 ? null : Array.from({ length: width }, (_, i) => cell(g, r, from + i));
    },
  };
}

/** Historique KPI : la ligne de titres, puis les lignes les plus récentes d'abord. */
export function parseHistory(g: Grid | undefined, max = 12): { head: string[]; rows: string[][] } {
  if (!g || g.d.length < 2) return { head: [], rows: [] };
  const width = (g.d[0] ?? []).findIndex((x, i) => i > 0 && !String(x).trim());
  const w = width === -1 ? g.d[0].length : width;
  const head = g.d[0].slice(0, w).map((x) => String(x).trim());
  const rows = g.d.slice(1).filter((r) => String(r?.[0] ?? '').trim()).map((r) => head.map((_, i) => String(r[i] ?? '').trim()));
  return { head, rows: rows.reverse().slice(0, max) };
}
