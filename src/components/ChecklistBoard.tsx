import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useChecklists, useRefresh } from '../lib/data';
import { frError, supabase } from '../lib/supabase';
import { fmtTime } from '../lib/time';
import { FREQUENCY_LABEL, PERIOD_NOW, type Checklist, type Frequency } from '../lib/types';
import { Icon } from './Icon';
import { Field, Loading, Sheet, Spinner, useToast } from './ui';
import { useCan } from '../lib/rights';

const TICK_ERROR: Record<string, string> = {
  not_yours: "Cette case a été cochée par quelqu'un d'autre : seule cette personne, ou le gérant, peut la décocher.",
  item: "Cette case n'existe plus.",
  no_profile: "Ton compte n'est pas rattaché à l'équipe.",
};

/**
 * Les checklists d'un type ('service' ou 'nettoyage') : on choisit une liste, on coche ses cases.
 * Le gérant peut créer et modifier les listes.
 */
export function ChecklistBoard({ kind }: { kind: Checklist['kind'] }) {
  const can = useCan();
  const editor = can('checklists');
  const toast = useToast();
  const refresh = useRefresh();
  const all = useChecklists();
  const lists = (all.data ?? []).filter((l) => l.kind === kind);
  const [sel, setSel] = useState('');
  const [busy, setBusy] = useState('');
  const [edit, setEdit] = useState<Checklist | 'new' | null>(null);
  const closeEdit = useCallback(() => setEdit(null), []);
  const cur = lists.find((l) => l.id === sel) ?? lists[0];

  useEffect(() => {
    if (cur && cur.id !== sel) setSel(cur.id);
  }, [cur, sel]);

  async function tick(itemId: string, done: boolean) {
    setBusy(itemId);
    const { data, error } = await supabase.rpc('tick_item', { p_item: itemId, p_done: done });
    setBusy('');
    const r = data as { ok: boolean; error?: string } | null;
    if (error) toast(frError(error), 'bad');
    else if (r && !r.ok) toast(TICK_ERROR[r.error ?? ''] ?? 'Action impossible.', 'bad');
    await refresh('checklists', 'tasks');
  }

  if (all.isLoading) return <Loading />;
  if (all.error) return <div className="list"><p className="empty err">{frError(all.error)}</p></div>;

  const n = cur?.items.length ?? 0;
  const d = cur?.items.filter((i) => i.done).length ?? 0;

  return (
    <>
      <div className="chips" role="group" aria-label="Listes">
        {lists.map((l) => {
          const done = l.items.filter((i) => i.done).length;
          return (
            <button key={l.id} type="button" className="chip" aria-pressed={l.id === cur?.id} onClick={() => setSel(l.id)} aria-label={`${l.name}, ${done} sur ${l.items.length}`}>
              {l.name} <small className="num" style={{ opacity: 0.7 }}>{done}/{l.items.length}</small>
            </button>
          );
        })}
        {editor && <button type="button" className="chip" onClick={() => setEdit('new')}><Icon name="plus" size={16} />Nouvelle liste</button>}
      </div>

      {!cur ? <div className="list"><p className="empty">Aucune liste pour l'instant.{editor ? ' Crée la première avec « Nouvelle liste ».' : ''}</p></div> : (
        <section className="sec">
          <div className="sec-h">
            <span className="t">{cur.name} · {PERIOD_NOW[cur.frequency].toLowerCase()}</span>
            <span className="sub num">{d} sur {n}</span>
          </div>
          <div className={'bar' + (n > 0 && d === n ? ' full' : '')} style={{ marginTop: 0 }}><i style={{ width: `${n ? (d / n) * 100 : 0}%` }} /></div>
          <div className="list">
            {n === 0 && <p className="empty">Cette liste n'a pas encore de case.</p>}
            {cur.items.map((it) => (
              <button type="button" key={it.id} className={'row' + (it.done ? ' done' : '')} aria-pressed={it.done} disabled={busy === it.id} onClick={() => void tick(it.id, !it.done)}>
                <span className="chk"><Icon name="tick" size={16} /></span>
                <span className="grow">
                  <span className="t">{it.label}</span>
                  {it.done && <span className="sub">Fait par {it.done_by_name ?? 'un ancien membre'}{it.done_at ? `, à ${fmtTime(it.done_at)}` : ''}</span>}
                </span>
              </button>
            ))}
          </div>
          {n > 0 && d === n && <p className="note"><span className="pill ok">Terminée</span> Tout est coché pour {PERIOD_NOW[cur.frequency].toLowerCase()}.</p>}
          {editor && <button type="button" className="btn" onClick={() => setEdit(cur)}>Modifier cette liste</button>}
        </section>
      )}

      {edit && <ChecklistSheet list={edit} kind={kind} onClose={closeEdit} onSaved={setSel} />}
    </>
  );
}

/* ---------- Créer ou modifier une liste (gérant) ---------- */
function ChecklistSheet({ list, kind, onClose, onSaved }: { list: Checklist | 'new'; kind: Checklist['kind']; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = list === 'new' ? null : list;
  const [name, setName] = useState(old?.name ?? '');
  const [frequency, setFrequency] = useState<Frequency>(old?.frequency ?? 'daily');
  const [items, setItems] = useState<{ id?: string; label: string }[]>(old ? old.items.map((i) => ({ id: i.id, label: i.label })) : [{ label: '' }]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const change = (i: number, label: string) => setItems((a) => a.map((x, k) => (k === i ? { ...x, label } : x)));
  const move = (i: number, by: number) => setItems((a) => {
    const j = i + by;
    if (j < 0 || j >= a.length) return a;
    const b = [...a];
    [b[i], b[j]] = [b[j], b[i]];
    return b;
  });

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { data, error } = await supabase.rpc('save_checklist', { p_id: old?.id ?? null, p_name: name, p_kind: kind, p_frequency: frequency, p_items: items.filter((i) => i.label.trim()) });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('checklists', 'tasks');
    toast(old ? 'Liste enregistrée' : 'Liste créée');
    onSaved(data as string);
    onClose();
  }

  async function remove() {
    if (!old) return;
    setBusy(true);
    const { error } = await supabase.from('checklists').update({ active: false }).eq('id', old.id);
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('checklists', 'tasks');
    toast('Liste retirée');
    onClose();
  }

  return (
    <Sheet title={old ? 'Modifier la liste' : 'Nouvelle liste'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <div className="two">
          <Field label="Nom de la liste">
            <input className="in" id="cl-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          </Field>
          <Field label="À refaire">
            <select className="in" id="cl-frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
              {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => (<option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>))}
            </select>
          </Field>
        </div>
        <div className="field">
          <span>Cases à cocher</span>
          {items.map((it, i) => (
            <div className="edit-row" key={i}>
              <input className="in" value={it.label} onChange={(e) => change(i, e.target.value)} placeholder="Ce qu'il faut faire" aria-label={`Case ${i + 1}`} maxLength={120} />
              <button type="button" className="btn sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Monter"><Icon name="up" size={16} /></button>
              <button type="button" className="btn sm" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Descendre"><Icon name="dn" size={16} /></button>
              <button type="button" className="btn sm no" onClick={() => setItems((a) => a.filter((_, k) => k !== i))} aria-label="Retirer cette case"><Icon name="x" size={16} /></button>
            </div>
          ))}
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setItems((a) => [...a, { label: '' }])}><Icon name="plus" size={16} />Ajouter une case</button>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && (confirm ? (
          <div className="acts">
            <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
            <button type="button" className="btn no" disabled={busy} onClick={() => void remove()}>Retirer la liste</button>
          </div>
        ) : (
          <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Retirer cette liste</button>
        ))}
        <p className="note">Retirer une case ou une liste ne supprime pas ce qui a déjà été coché : l'historique reste disponible.</p>
      </form>
    </Sheet>
  );
}
