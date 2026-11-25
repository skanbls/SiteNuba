import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { DENOMINATIONS, GAP_LIMIT, calc, closingsCsv, denomLabel, isBill, maxGap, num, type CashClosing } from '../lib/cash';
import { useChecklists, useTeam } from '../lib/data';
import { resizePhoto } from '../lib/process';
import { useCan } from '../lib/rights';
import { frError, supabase } from '../lib/supabase';
import { dayKey, fmtDayLong, fmtTime, fromDayKey } from '../lib/time';

const euro = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const eur = (n: number | null | undefined) => (n === null || n === undefined ? '–' : euro.format(n));
const signed = (n: number | null | undefined) => (n === null || n === undefined ? '–' : `${n > 0 ? '+' : ''}${euro.format(n)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const longDay = (d: string) => cap(fmtDayLong(fromDayKey(d)));

interface Got { day: string; closing: CashClosing | null; previous_float: number | null; closed_by_name: string | null; can_edit: boolean }

const Z_FIELDS = ['z_total', 'z_covers', 'z_tickets', 'z_cash', 'z_card', 'z_meal', 'z_cheque', 'z_other'] as const;
const OTHER_FIELDS = ['float_start', 'float_end', 'card_counted', 'meal_counted', 'cheque_counted', 'tips'] as const;
type NumField = (typeof Z_FIELDS)[number] | (typeof OTHER_FIELDS)[number];
type Form = Record<NumField, string> & { z_number: string; note: string; counts: Record<string, string>; expenses: { label: string; amount: string }[] };

const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
function toForm(g: Got): Form {
  const c = g.closing;
  const f = Object.fromEntries([...Z_FIELDS, ...OTHER_FIELDS].map((k) => [k, str(c?.[k] as number | null)])) as Record<NumField, string>;
  if ((c?.float_start ?? null) === null && g.previous_float !== null) f.float_start = str(g.previous_float);
  return {
    ...f, z_number: c?.z_number ?? '', note: c?.note ?? '',
    counts: Object.fromEntries(Object.entries(c?.cash_counts ?? {}).map(([k, v]) => [k, String(v)])),
    expenses: (c?.expenses ?? []).map((e) => ({ label: e.label, amount: str(e.amount) })),
  };
}
function toPayload(f: Form) {
  const p: Record<string, unknown> = { z_number: f.z_number.trim(), note: f.note.trim() };
  for (const k of [...Z_FIELDS, ...OTHER_FIELDS]) p[k] = num(f[k]);
  p.cash_counts = Object.fromEntries(Object.entries(f.counts).map(([k, v]) => [k, num(v)]).filter(([, v]) => v !== null && (v as number) >= 0));
  p.expenses = f.expenses.map((e) => ({ label: e.label.trim(), amount: num(e.amount) })).filter((e) => e.label && e.amount !== null && e.amount > 0);
  return p;
}

/**
 * Fermeture de caisse : le ticket Z, le comptage des espèces, le terminal CB, les écarts et la photo du Z.
 * Toute l'équipe ferme la caisse du jour (téléphone ou iPad) ; le gérant et l'accès « Caisse » voient l'historique et corrigent.
 */
export default function Closing() {
  const can = useCan();
  const manager = can('caisse');
  const [params, setParams] = useSearchParams();
  const day = params.get('j') ?? '';
  const [tab, setTab] = useState<'jour' | 'historique'>('jour');
  const got = useQuery({
    queryKey: ['caisse', 'jour', day],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cash_closing_get', { p_day: day || null });
      if (error) throw error;
      return data as Got;
    },
  });

  return (
    <Layout title="Fermeture de caisse">
      {manager && <Chips value={tab} options={[['jour', day ? 'Fermeture' : 'Ce soir'], ['historique', 'Historique']]} onChange={setTab} label="Rubrique" />}
      {tab === 'historique' && manager ? (
        <History onOpen={(d) => { setParams({ j: d }); setTab('jour'); }} />
      ) : got.isLoading ? <Loading /> : got.error ? (
        <div className="list"><p className="empty err">{/function|schema cache|does not exist/i.test(String((got.error as Error).message)) ? "La fermeture de caisse attend la mise à jour 0026 de la base : le gérant doit l'exécuter dans Supabase." : frError(got.error)}</p></div>
      ) : got.data ? (
        <>
          {day && <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setParams({})}>Revenir à ce soir</button>}
          {/* Une seule saisie par jour : ce qui est tapé reste à l'écran après un enregistrement ou une photo. */}
          <ClosingForm key={got.data.day} got={got.data} />
        </>
      ) : null}
    </Layout>
  );
}

/* ---------- Le formulaire d'un jour ---------- */
function ClosingForm({ got }: { got: Got }) {
  const toast = useToast();
  const qc = useQueryClient();
  const checklists = useChecklists();
  const [f, setF] = useState<Form>(() => toForm(got));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [photo, setPhoto] = useState('');
  const c = got.closing;
  const closed = c?.status === 'closed';
  const ro = !got.can_edit;
  const k = useMemo(() => calc({ ...f, counts: f.counts }), [f]);
  const gap = maxGap(k);
  const set = (key: keyof Form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [key]: e.target.value }));
  const closingLists = (checklists.data ?? []).filter((l) => /fermeture/i.test(l.name));

  useEffect(() => {
    if (!c?.has_photo) return;
    void supabase.rpc('closing_photo', { p_day: got.day }).then(({ data }) => {
      const p = data as { mime: string; data: string } | null;
      if (p) setPhoto(`data:${p.mime};base64,${p.data}`);
    });
  }, [c?.has_photo, got.day]);

  async function save(close: boolean) {
    setBusy(close ? 'close' : 'save');
    setErr('');
    const { error } = await supabase.rpc('save_cash_closing', { p_day: got.day, p: toPayload(f), p_close: close });
    setBusy('');
    if (error) return setErr(frError(error));
    await qc.invalidateQueries({ queryKey: ['caisse'] });
    toast(close ? 'Caisse clôturée, le gérant reçoit le récapitulatif' : 'Brouillon enregistré');
  }

  async function pickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy('photo');
    setErr('');
    try {
      const small = await resizePhoto(file, 1400);
      const b64 = await new Promise<string>((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = ko; r.readAsDataURL(small); });
      const mime = small.type === 'image/png' || small.type === 'image/webp' ? small.type : 'image/jpeg';
      const { error } = await supabase.rpc('set_closing_photo', { p_day: got.day, p_mime: mime, p_data: b64 });
      if (error) throw new Error(frError(error));
      setPhoto(`data:${mime};base64,${b64}`);
      await qc.invalidateQueries({ queryKey: ['caisse'] });
      toast('Photo du Z enregistrée');
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy('');
    }
  }

  const money = (key: NumField, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="in num" id={key.replace('_', '-')} inputMode="decimal" value={f[key]} onChange={set(key)} readOnly={ro} />
    </Field>
  );
  const gapPill = (g: number | null, label: string) => g === null ? null : (
    <div className="row" data-gap={label}>
      <span className="grow t">{label}</span>
      <span className={`pill ${Math.abs(g) > GAP_LIMIT ? 'bad' : Math.abs(g) > 0 ? 'warn' : 'ok'}`}>{signed(g)}</span>
    </div>
  );

  return (
    <div className="form closing">
      <p className="lead">{longDay(got.day)}</p>
      {closed && (
        <p className="note" data-closed>
          <span className="pill ok">Clôturée</span> par {got.closed_by_name ?? "quelqu'un de l'équipe"}{c?.closed_at ? `, à ${fmtTime(c.closed_at)}` : ''}.
          {ro ? ' Pour corriger, demande au gérant ou à un responsable de la caisse.' : ''}
        </p>
      )}

      {closingLists.length > 0 && (
        <div className="list">
          {closingLists.map((l) => {
            const done = l.items.filter((i) => i.done).length;
            return (
              <Link className="row" key={l.id} to={`/checklists?l=${l.id}`}>
                <span className="grow"><span className="t">{l.name}</span><span className="sub">{done} sur {l.items.length} cases cochées</span></span>
                <span className="end">{done === l.items.length && l.items.length > 0 ? <span className="pill ok">Faite</span> : <span className="pill warn">À finir</span>}<span className="chev"><Icon name="chev" size={18} /></span></span>
              </Link>
            );
          })}
        </div>
      )}

      <Section title="1. Le ticket Z (caisse Zelty)">
        <p className="note">Imprime le Z de fin de journée et recopie ses totaux.</p>
        <div className="two">
          <Field label="N° du Z"><input className="in" id="z-number" value={f.z_number} onChange={set('z_number')} maxLength={40} readOnly={ro} /></Field>
          {money('z_total', 'CA TTC du jour')}
        </div>
        <div className="two">
          {money('z_covers', 'Couverts')}
          {money('z_tickets', 'Tickets (additions)')}
        </div>
        <div className="two">
          {money('z_cash', 'Espèces')}
          {money('z_card', 'Carte bancaire')}
        </div>
        <div className="two">
          {money('z_meal', 'Titres-restaurant')}
          {money('z_cheque', 'Chèques')}
        </div>
        {money('z_other', 'Autres paiements', 'Virements, avoirs, chèques-vacances…')}
        <Field label="Photo du Z" hint="Elle est rangée avec la fermeture, pour le gérant et la comptable.">
          <input className="in" id="z-photo" type="file" accept="image/*" capture="environment" onChange={(e) => void pickPhoto(e)} disabled={ro || busy === 'photo'} />
        </Field>
        {busy === 'photo' && <Spinner />}
        {photo && <img className="poster" src={photo} alt="Photo du ticket Z" style={{ maxHeight: 320 }} />}
      </Section>

      <Section title="2. Les espèces">
        {money('float_start', 'Fond de caisse au départ', got.previous_float !== null ? `Laissé hier : ${eur(got.previous_float)}` : undefined)}
        <div className="field">
          <span>Comptage, billet par billet et pièce par pièce</span>
          <div className="denoms">
            {DENOMINATIONS.map((d) => (
              <label key={d} className={'denom' + (isBill(d) ? ' bill' : '')}>
                <span>{denomLabel(d)}</span>
                <input className="in num" id={`cnt-${d}`} inputMode="numeric" value={f.counts[String(d)] ?? ''} aria-label={`${isBill(d) ? 'Billets' : 'Pièces'} de ${denomLabel(d)}`}
                  onChange={(e) => setF((x) => ({ ...x, counts: { ...x.counts, [String(d)]: e.target.value.replace(/[^0-9]/g, '') } }))} readOnly={ro} />
              </label>
            ))}
          </div>
          <small data-testid="cash-counted">Total compté : <b className="num">{eur(k.counted)}</b></small>
        </div>
        <div className="field">
          <span>Dépenses payées en espèces</span>
          {f.expenses.map((e, i) => (
            <div className="edit-row" key={i}>
              <input className="in" id={`exp-label-${i}`} value={e.label} placeholder="Glaçons, pain…" aria-label={`Dépense ${i + 1}`} readOnly={ro}
                onChange={(ev) => setF((x) => ({ ...x, expenses: x.expenses.map((y, j) => (j === i ? { ...y, label: ev.target.value } : y)) }))} />
              <input className="in num" id={`exp-amount-${i}`} inputMode="decimal" value={e.amount} placeholder="€" aria-label={`Montant de la dépense ${i + 1}`} style={{ maxWidth: 110 }} readOnly={ro}
                onChange={(ev) => setF((x) => ({ ...x, expenses: x.expenses.map((y, j) => (j === i ? { ...y, amount: ev.target.value } : y)) }))} />
              {!ro && <button type="button" className="btn sm no" aria-label="Retirer cette dépense" onClick={() => setF((x) => ({ ...x, expenses: x.expenses.filter((_, j) => j !== i) }))}><Icon name="x" size={16} /></button>}
            </div>
          ))}
          {!ro && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setF((x) => ({ ...x, expenses: [...x.expenses, { label: '', amount: '' }] }))}><Icon name="plus" size={16} />Ajouter une dépense</button>}
        </div>
        {money('float_end', 'Fond laissé pour demain', 'Le reste part en banque.')}
      </Section>

      <Section title="3. Carte bancaire, titres-restaurant, chèques">
        {money('card_counted', 'Total du terminal CB', 'Le ticket de fin de journée (télécollecte) du terminal.')}
        <div className="two">
          {money('meal_counted', 'Titres-restaurant comptés')}
          {money('cheque_counted', 'Chèques comptés')}
        </div>
        {money('tips', 'Pourboires', 'Facultatif.')}
      </Section>

      <Section title="4. Le bilan">
        <div className="list">
          <div className="row"><span className="grow t">Espèces attendues</span><span className="end num">{eur(k.expected)}</span></div>
          <div className="row"><span className="grow t">Espèces comptées</span><span className="end num">{eur(k.counted)}</span></div>
          {gapPill(k.cashGap, 'Écart espèces')}
          {gapPill(k.cardGap, 'Écart carte bancaire')}
          {gapPill(k.mealGap, 'Écart titres-restaurant')}
          {gapPill(k.chequeGap, 'Écart chèques')}
          <div className="row"><span className="grow t">Remise en banque</span><span className="end num" data-testid="bank-deposit"><b>{eur(k.deposit)}</b></span></div>
        </div>
        <Field label={gap > GAP_LIMIT ? 'Explique l\'écart (obligatoire)' : 'Note'} hint="Rendu de monnaie, ticket annulé, pourboire laissé en caisse…">
          <textarea className="in" id="cash-note" value={f.note} onChange={set('note')} maxLength={1000} readOnly={ro} />
        </Field>
      </Section>

      {err && <p className="err" role="alert">{err}</p>}
      {!ro && (
        <div className="acts">
          <button type="button" className="btn" disabled={!!busy} onClick={() => void save(false)}>{busy === 'save' ? <Spinner /> : 'Enregistrer le brouillon'}</button>
          <button type="button" className="btn pri" disabled={!!busy} onClick={() => void save(true)}>{busy === 'close' ? <Spinner /> : closed ? 'Enregistrer la correction' : 'Clôturer la caisse'}</button>
        </div>
      )}
      <p className="note">Le brouillon se reprend sur n'importe quel appareil. À la clôture, la base vérifie le Z, le comptage et le terminal CB ; un écart de plus de {GAP_LIMIT} € demande une explication.</p>
    </div>
  );
}

/* ---------- Historique (gérant, accès « Caisse ») et export pour la comptable ---------- */
const gapsOf = (c: CashClosing) => [c.cash_gap, c.card_gap, c.meal_gap, c.cheque_gap].filter((g): g is number => g !== null && g !== undefined);
/** Le plus grand écart d'une fermeture (espèces, CB, titres, chèques), avec son signe. */
const worstGap = (c: CashClosing) => gapsOf(c).reduce((w, g) => (Math.abs(g) > Math.abs(w) ? g : w), 0);
const worst = (c: CashClosing) => Math.abs(worstGap(c));
export function History({ onOpen, accountant = false }: { onOpen?: (day: string) => void; accountant?: boolean }) {
  const team = useTeam();
  // Le mois du jour de service (de 5 h à 5 h).
  const [month, setMonth] = useState(() => dayKey(new Date(Date.now() - 5 * 3600_000)).slice(0, 7));
  const [photo, setPhoto] = useState<{ day: string; src: string } | null>(null);
  // La comptable n'a pas accès aux fiches de l'équipe : les prénoms viennent de son récap (hours_report).
  const people = useQuery({
    queryKey: ['caisse', 'noms', month],
    enabled: accountant,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('hours_report', { p_from: `${month}-01`, p_to: `${month}-28` });
      if (error) throw error;
      return ((data as { people?: { id: string; first_name: string }[] }).people ?? []);
    },
  });
  const names = useMemo(() => new Map(((accountant ? people.data : team.data) ?? []).map((p) => [p.id, p.first_name])), [accountant, people.data, team.data]);
  const list = useQuery({
    queryKey: ['caisse', 'historique', month],
    queryFn: async () => {
      const end = new Date(`${month}-15T12:00:00Z`);
      end.setUTCMonth(end.getUTCMonth() + 1);
      const { data, error } = await supabase.from('cash_closings').select('*').gte('day', `${month}-01`).lt('day', `${end.toISOString().slice(0, 7)}-01`).order('day', { ascending: false });
      if (error) throw error;
      return (data ?? []) as CashClosing[];
    },
  });
  const rows = list.data ?? [];
  const closed = rows.filter((c) => c.status === 'closed');
  const ca = closed.reduce((t, c) => t + (c.z_total ?? 0), 0);
  const covers = closed.reduce((t, c) => t + (c.z_covers ?? 0), 0);
  const gaps = closed.reduce((t, c) => t + (c.cash_gap ?? 0), 0);

  async function showPhoto(day: string) {
    const { data, error } = await supabase.rpc('closing_photo', { p_day: day });
    const p = data as { mime: string; data: string } | null;
    if (error || !p) return;
    setPhoto({ day, src: `data:${p.mime};base64,${p.data}` });
  }

  function exportCsv() {
    const blob = new Blob([`﻿${closingsCsv(closed, names)}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fermetures-caisse-${month}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return (
    <>
      <div className="acts">
        <input className="in" type="month" id="caisse-mois" value={month} onChange={(e) => setMonth(e.target.value || month)} aria-label="Mois" style={{ flex: '1 1 160px' }} />
        <button type="button" className="btn" disabled={closed.length === 0} onClick={exportCsv}><Icon name="down" />Exporter le mois (CSV)</button>
      </div>
      {list.isLoading ? <Loading /> : list.error ? <div className="list"><p className="empty err">{frError(list.error)}</p></div> : (
        <>
          <div className="stats">
            <div className="stat"><div className="v num">{euro.format(Math.round(ca))}</div><div className="k">CA TTC du mois</div></div>
            <div className="stat"><div className="v num">{covers}</div><div className="k">couverts{covers ? ` · ${euro.format(ca / covers)} en moyenne` : ''}</div></div>
            <div className="stat"><div className="v num">{signed(Math.round(gaps * 100) / 100)}</div><div className="k">écarts d'espèces</div></div>
          </div>
          <div className="list">
            {rows.length === 0 && <p className="empty">Aucune fermeture ce mois-ci.</p>}
            {rows.map((c) => {
              const inner = (
                <>
                  <span className="grow">
                    <span className="t">{longDay(c.day)}</span>
                    <span className="sub num">{eur(c.z_total)} TTC{c.z_covers ? ` · ${c.z_covers} couverts` : ''}{c.closed_by && names.get(c.closed_by) ? ` · ${names.get(c.closed_by)}` : ''}</span>
                  </span>
                  <span className="end">
                    {c.status === 'draft' ? <span className="pill warn">Brouillon</span>
                      : worst(c) > GAP_LIMIT ? <span className="pill bad">Écart {signed(worstGap(c))}</span> : <span className="pill ok">Juste</span>}
                    {accountant && c.has_photo && <button type="button" className="btn sm" onClick={() => void showPhoto(c.day)}><Icon name="cam" size={16} />Z</button>}
                    {!accountant && <span className="chev"><Icon name="chev" size={18} /></span>}
                  </span>
                </>
              );
              return accountant || !onOpen
                ? <div className="row" key={c.id} data-closing={c.day}>{inner}</div>
                : <button type="button" className="row" key={c.id} data-closing={c.day} onClick={() => onOpen(c.day)}>{inner}</button>;
            })}
          </div>
        </>
      )}
      {photo && (
        <Sheet title={`Ticket Z · ${longDay(photo.day)}`} onClose={() => setPhoto(null)}>
          <img className="poster" src={photo.src} alt="Photo du ticket Z" />
        </Sheet>
      )}
    </>
  );
}
