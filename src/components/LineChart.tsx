import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

/**
 * Courbe dans le temps, faite à la main en SVG : une série principale (vert Nuba),
 * éventuellement une série de contexte (gris), des seuils nommés, un survol qui suit
 * le doigt ou la souris (et les flèches du clavier), et le tableau des chiffres.
 */
export interface LineSeries { name: string; values: (number | null)[]; kind: 'main' | 'context' }
export interface RefLine { name: string; value: number; tone: 'ok' | 'bad' }

const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
export const fmtEuro0 = (n: number | null | undefined) => (n == null ? '–' : euro.format(n));
/** Graduation : en entier sous 10 000, « 20 k€ » au-delà. */
const tick = (n: number, big: boolean) => (big ? `${(n / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k€` : euro.format(n));
const ok = (v: number | null): v is number => v != null && Number.isFinite(v);
/** Classe d'une série : « main » est déjà pris par la mise en page. */
const cls = (kind: LineSeries['kind']) => (kind === 'main' ? 'is-main' : 'is-ctx');

/** Graduations rondes qui couvrent [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
  return out;
}

export function LineChart({ labels, series, refs = [], extra, label, testId }: {
  labels: string[];
  series: LineSeries[];
  refs?: RefLine[];
  /** Une ligne de plus dans la bulle et le tableau, par colonne (par exemple l'état de la semaine). */
  extra?: { name: string; values: string[] };
  /** Nom du graphique pour les lecteurs d'écran. */
  label: string;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = labels.length;
  const H = 230;
  const m = { l: w < 420 ? 50 : 62, r: 14, t: 16, b: 30 };
  const pw = Math.max(60, w - m.l - m.r);
  const ph = H - m.t - m.b;
  const values = [...series.flatMap((s) => s.values.filter(ok)), ...refs.map((r) => r.value), 0];
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const big = Math.max(Math.abs(lo), Math.abs(hi)) >= 10000;
  const x = (i: number) => m.l + (n <= 1 ? pw / 2 : (i * pw) / (n - 1));
  const y = (v: number) => m.t + ph - ((v - lo) / (hi - lo)) * ph;
  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (!ok(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  // Une étiquette sur deux, trois… selon la place : environ 6,5 px par caractère.
  const labelW = Math.max(...labels.map((l) => l.length), 1) * 6.5 + 12;
  const step = Math.max(1, Math.ceil((n * labelW) / pw));
  const main = series.find((s) => s.kind === 'main');
  const mainVals = main?.values ?? [];
  const lowest = mainVals.reduce<number>((k, v, i) => (ok(v) && (!ok(mainVals[k]) || v < (mainVals[k] as number)) ? i : k), 0);
  const last = mainVals.reduce<number>((k, v, i) => (ok(v) ? i : k), -1);
  // « Plus bas » n'a de sens qu'à partir de deux points.
  const several = mainVals.filter(ok).length >= 2;

  function move(e: PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
    setAt(Math.max(0, Math.min(n - 1, i)));
  }
  function key(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') { e.preventDefault(); setAt((a) => Math.min(n - 1, (a ?? -1) + 1)); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setAt((a) => Math.max(0, (a ?? n) - 1)); }
    if (e.key === 'Escape') setAt(null);
  }

  const tipLeft = at == null ? 0 : Math.min(Math.max(x(at) - 90, 0), w - 180);
  const rows: ReactNode[] = at == null ? [] : series.map((s) => (
    <div className="tip-row" key={s.name}>
      <span className={`lkey ${cls(s.kind)}`} />
      <strong className="num">{fmtEuro0(s.values[at])}</strong>
      <span>{s.name}</span>
    </div>
  ));

  return (
    <div className="chart" data-testid={testId}>
      {(series.length > 1 || refs.length > 0) && (
        <div className="chart-legend">
          {series.length > 1 && series.map((s) => (<span key={s.name}><span className={`lkey ${cls(s.kind)}`} />{s.name}</span>))}
          {refs.map((r) => (<span key={r.name}><span className={`lkey ref-${r.tone}`} />{r.name} {fmtEuro0(r.value)}</span>))}
        </div>
      )}
      <div className="chart-box" ref={box}>
        <svg width={w} height={H} role="img" aria-label={label} tabIndex={0} onKeyDown={key} onBlur={() => setAt(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={m.l} x2={m.l + pw} y1={y(t)} y2={y(t)} />
              <text className="axis" x={m.l - 8} y={y(t) + 4} textAnchor="end">{tick(t, big)}</text>
            </g>
          ))}
          {labels.map((l, i) => (i % step === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= step || i === 0) ? (
            <text key={i} className="axis" x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{l}</text>
          ) : null)}
          {refs.map((r) => (<line key={r.name} className={`ref ${r.tone}`} x1={m.l} x2={m.l + pw} y1={y(r.value)} y2={y(r.value)} />))}
          {at != null && <line className="cross" x1={x(at)} x2={x(at)} y1={m.t} y2={m.t + ph} />}
          {series.filter((s) => s.kind === 'context').map((s) => (<path key={s.name} className="line is-ctx" d={path(s.values)} />))}
          {main && <path className="line is-main" d={path(main.values)} />}
          {main && several && ok(mainVals[lowest]) && (
            <g>
              <circle className="dot is-main" cx={x(lowest)} cy={y(mainVals[lowest] as number)} r={4.5} />
              <text className="point-label" x={x(lowest)} y={y(mainVals[lowest] as number) + (y(mainVals[lowest] as number) + 22 > m.t + ph ? -12 : 18)} textAnchor={lowest === 0 ? 'start' : lowest === n - 1 ? 'end' : 'middle'}>
                plus bas {fmtEuro0(mainVals[lowest])}
              </text>
            </g>
          )}
          {main && last >= 0 && (last !== lowest || !several) && (
            <g>
              <circle className="dot is-main" cx={x(last)} cy={y(mainVals[last] as number)} r={4.5} />
              <text className="point-label" x={x(last)} y={y(mainVals[last] as number) - 10} textAnchor="end">{fmtEuro0(mainVals[last])}</text>
            </g>
          )}
          {at != null && series.map((s) => (ok(s.values[at]) ? <circle key={s.name} className={`dot ${cls(s.kind)}`} cx={x(at)} cy={y(s.values[at] as number)} r={4.5} /> : null))}
          <rect x={m.l - 10} y={m.t} width={pw + 20} height={ph} fill="transparent" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setAt(null)} />
        </svg>
        {at != null && (
          <div className="chart-tip" style={{ left: tipLeft }} role="status">
            <div className="tip-head">{labels[at]}</div>
            {rows}
            {extra && extra.values[at] && <div className="tip-row"><span className="lkey none" /><span>{extra.name} : {extra.values[at]}</span></div>}
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>Voir les chiffres</summary>
        <div className="table-scroll">
          <table>
            <thead><tr><th />{series.map((s) => <th key={s.name}>{s.name}</th>)}{extra && <th>{extra.name}</th>}</tr></thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={i}><th>{l}</th>{series.map((s) => <td key={s.name} className="num">{fmtEuro0(s.values[i])}</td>)}{extra && <td>{extra.values[i]}</td>}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
