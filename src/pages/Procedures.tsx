import { useCallback, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useProcedureReads, useProcedures, useRefresh, useTeam } from '../lib/data';
import { useMe } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { fmtDateShort } from '../lib/time';
import { fullName, type Procedure } from '../lib/types';
import { useCan } from '../lib/rights';

/** Procédures et formation : consignes à lire, lecture confirmée par chacun. */
export default function Procedures() {
  const me = useMe();
  const can = useCan();
  const editor = can('procedures');
  const procedures = useProcedures();
  const reads = useProcedureReads();
  const [open, setOpen] = useState<Procedure | 'new' | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const all = (procedures.data ?? []).filter((p) => p.active || editor);
  const mine = new Map((reads.data ?? []).filter((r) => r.profile_id === me.id).map((r) => [r.procedure_id, r.read_at]));
  const cats = Array.from(new Set(all.map((p) => p.category)));

  return (
    <Layout title="Procédures" right={editor && <button type="button" className="btn sm pri" onClick={() => setOpen('new')}><Icon name="plus" size={16} />Procédure</button>}>
      {procedures.isLoading ? <Loading /> : procedures.error ? <div className="list"><p className="empty err">{frError(procedures.error)}</p></div> : (
        <>
          {all.length === 0 && <div className="list"><p className="empty">Aucune procédure pour l'instant.</p></div>}
          {cats.map((c) => (
            <Section title={c} key={c}>
              <div className="list">
                {all.filter((p) => p.category === c).map((p) => (
                  <button type="button" className="row wrap" key={p.id} data-procedure={p.title} onClick={() => setOpen(p)} style={p.active ? undefined : { opacity: 0.6 }}>
                    <span className="grow"><span className="t">{p.title}</span><span className="sub">Mise à jour le {fmtDateShort(new Date(p.updated_at))}</span></span>
                    <span className="end">
                      {!p.active ? <span className="pill">Retirée</span> : mine.has(p.id) ? <span className="pill ok">Lue</span> : p.must_read ? <span className="pill warn">À lire</span> : <span className="pill">Facultative</span>}
                      <span className="chev"><Icon name="chev" size={18} /></span>
                    </span>
                  </button>
                ))}
              </div>
            </Section>
          ))}
          <p className="note">Lis chaque procédure, puis confirme ta lecture. {editor ? 'Tu vois qui a lu quoi en ouvrant une procédure.' : 'Le gérant voit ce que chacun a lu.'}</p>
        </>
      )}
      {open && <ProcedureSheet key={open === 'new' ? 'new' : open.id} procedure={open} editor={editor} readAt={open === 'new' ? undefined : mine.get(open.id)} onClose={close} />}
    </Layout>
  );
}

function ProcedureSheet({ procedure, editor, readAt, onClose }: { procedure: Procedure | 'new'; editor: boolean; readAt: string | undefined; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const team = useTeam();
  const reads = useProcedureReads();
  const old = procedure === 'new' ? null : procedure;
  const [editing, setEditing] = useState(!old);
  const [title, setTitle] = useState(old?.title ?? '');
  const [category, setCategory] = useState(old?.category ?? 'Général');
  const [body, setBody] = useState(old?.body ?? '');
  const [must, setMust] = useState(old?.must_read ?? true);
  const [reset, setReset] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('procedures', 'tasks');
    toast(done);
    onClose();
  }

  if (editing)
    return (
      <Sheet title={old ? 'Modifier la procédure' : 'Nouvelle procédure'} onClose={onClose}>
        <form className="form" onSubmit={(e: FormEvent) => { e.preventDefault(); void run(() => supabase.rpc('save_procedure', { p_id: old?.id ?? null, p_title: title, p_category: category, p_body: body, p_must_read: must, p_reset: reset }), old ? 'Procédure enregistrée' : 'Procédure créée'); }}>
          <div className="two">
            <Field label="Titre"><input className="in" id="proc-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={100} /></Field>
            <Field label="Rubrique"><input className="in" id="proc-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Accueil, Hygiène, Service, Sécurité…" maxLength={40} /></Field>
          </div>
          <Field label="Texte" hint="Des phrases courtes, une consigne par ligne."><textarea className="in" id="proc-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={8000} style={{ minHeight: 220 }} /></Field>
          <label className="row" style={{ padding: 0, gap: 10 }}>
            <input id="proc-must" type="checkbox" checked={must} onChange={(e) => setMust(e.target.checked)} style={{ width: 22, height: 22 }} />
            <span className="grow"><span className="t">Lecture demandée à toute l'équipe</span><span className="sub">Elle apparaît sur l'accueil de chacun tant qu'elle n'est pas lue.</span></span>
          </label>
          {old && (
            <label className="row" style={{ padding: 0, gap: 10 }}>
              <input id="proc-reset" type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} style={{ width: 22, height: 22 }} />
              <span className="grow"><span className="t">Redemander la lecture</span><span className="sub">À cocher si le changement est important : chacun devra la relire.</span></span>
            </label>
          )}
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
          {old && <button type="button" className="btn block" disabled={busy} onClick={() => void run(() => supabase.from('procedures').update({ active: !old.active }).eq('id', old.id), old.active ? 'Procédure retirée' : 'Procédure rétablie')}>{old.active ? 'Retirer cette procédure' : 'Rétablir cette procédure'}</button>}
        </form>
      </Sheet>
    );

  const p = old!;
  const done = new Map((reads.data ?? []).filter((r) => r.procedure_id === p.id).map((r) => [r.profile_id, r.read_at]));
  return (
    <Sheet title={p.title} onClose={onClose}>
      <p className="sub">{p.category} · mise à jour le {fmtDateShort(new Date(p.updated_at))}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{p.body || 'Cette procédure est encore vide.'}</p>
      {err && <p className="err" role="alert">{err}</p>}
      {readAt
        ? <p className="okmsg">Tu as confirmé ta lecture le {fmtDateShort(new Date(readAt))}.</p>
        : p.active && <button type="button" className="btn pri block" disabled={busy} onClick={() => void run(() => supabase.rpc('ack_procedure', { p_id: p.id }), 'Lecture confirmée')}>J'ai lu et compris</button>}
      {editor && (
        <>
          <Section title="Qui l'a lue">
            <div className="list">
              {(team.data ?? []).filter((m) => m.active).map((m) => (
                <div className="row" key={m.id}><span className="grow t" style={{ fontWeight: 500 }}>{fullName(m)}</span>{done.has(m.id) ? <span className="pill ok">Lue le {fmtDateShort(new Date(done.get(m.id)!))}</span> : <span className="pill warn">Pas encore</span>}</div>
              ))}
            </div>
          </Section>
          <button type="button" className="btn block" onClick={() => setEditing(true)}>Modifier cette procédure</button>
        </>
      )}
    </Sheet>
  );
}
