import { useState, type FormEvent } from 'react';
import { Icon } from './Icon';
import { Field, Section, Sheet, Spinner, useToast } from './ui';
import { documentUrl, fileProblem, sendDocument } from '../lib/documents';
import { useRefresh, useTeamDocuments } from '../lib/data';
import { frError, supabase } from '../lib/supabase';
import { fmtDate } from '../lib/time';
import { DOC_CATEGORIES, DOC_LABEL, type DocCategory, type StaffDocument } from '../lib/types';

const day = (d: string) => d.split('-').reverse().join('/');

/** Ouvre un document dans un nouvel onglet (lien valable deux minutes). */
export function OpenButton({ doc }: { doc: StaffDocument }) {
  const toast = useToast();
  const [link, setLink] = useState('');
  async function open() {
    // Fenêtre ouverte tout de suite, au toucher : sinon l'iPhone la bloque.
    const w = window.open('', '_blank');
    try {
      const url = await documentUrl(doc.file_path);
      if (w) w.location.href = url;
      else setLink(url);
    } catch (e) {
      w?.close();
      toast(frError(e), 'bad');
    }
  }
  return link
    ? <a className="btn sm pri" href={link} target="_blank" rel="noopener noreferrer" onClick={() => setLink('')}>Afficher</a>
    : <button type="button" className="btn sm" onClick={() => void open()} aria-label={`Ouvrir ${DOC_LABEL[doc.category]}`}><Icon name="doc" size={16} />Ouvrir</button>;
}

/** Une ligne de document : catégorie, dates, date d'envoi. */
export function DocRow({ doc, who, onDelete }: { doc: StaffDocument; who?: string; onDelete?: () => void }) {
  const dates = doc.start_date ? (doc.end_date && doc.end_date !== doc.start_date ? `du ${day(doc.start_date)} au ${day(doc.end_date)}` : `le ${day(doc.start_date)}`) : '';
  return (
    <div className="row wrap" data-doc={DOC_LABEL[doc.category]}>
      <span className="grow">
        <span className="t">{who ? `${who} · ` : ''}{DOC_LABEL[doc.category]}</span>
        <span className="sub">{[doc.title && doc.title !== DOC_LABEL[doc.category] ? doc.title : '', dates, `envoyé le ${fmtDate(doc.created_at)}`].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="end">
        <OpenButton doc={doc} />
        {onDelete && <button type="button" className="btn sm no" onClick={onDelete} aria-label={`Supprimer ${DOC_LABEL[doc.category]}`}><Icon name="x" size={16} /></button>}
      </span>
    </div>
  );
}

/**
 * Envoyer un document : arrêt de travail, pièce d'identité, carte Vitale…
 * `forOther` : le gérant envoie pour quelqu'un (toutes les catégories, DPAE comprise).
 */
export function DocumentSheet({ profileId, name, forOther = false, category: first = 'arret', onClose }: {
  profileId: string; name?: string; forOther?: boolean; category?: DocCategory; onClose: () => void;
}) {
  const toast = useToast();
  const refresh = useRefresh();
  const [category, setCategory] = useState<DocCategory>(first);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const cat = DOC_CATEGORIES.find((c) => c.key === category)!;
  const choices = DOC_CATEGORIES.filter((c) => forOther || c.self);
  const groups = Array.from(new Set(choices.map((c) => c.group)));

  async function send(e: FormEvent) {
    e.preventDefault();
    const bad = fileProblem(file);
    if (bad) return setErr(bad);
    if ((category === 'arret' || category === 'accident') && !start) return setErr("Indique la date de début de l'arrêt.");
    if (end && start && end < start) return setErr('La fin est avant le début.');
    setBusy(true);
    setErr('');
    const problem = await sendDocument(file!, profileId, { category, title, start: cat.dates ? start : '', end: cat.dates ? end : '', note });
    setBusy(false);
    if (problem) return setErr(frError({ message: problem }));
    await refresh('documents', 'leaves');
    toast(category === 'arret' || category === 'accident' ? "Arrêt envoyé : il est noté dans le planning et la comptable est prévenue" : 'Document envoyé');
    onClose();
  }

  return (
    <Sheet title={name ? `Document pour ${name}` : 'Envoyer un document'} onClose={onClose}>
      <form className="form" onSubmit={send}>
        <Field label="Quel document ?">
          <select className="in" id="doc-category" value={category} onChange={(e) => setCategory(e.target.value as DocCategory)}>
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {choices.filter((c) => c.group === g).map((c) => (<option key={c.key} value={c.key}>{c.label}</option>))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Fichier" hint="Un PDF, ou une photo bien nette et bien éclairée, de tout le document. 10 Mo au plus.">
          <input className="in" id="doc-file" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </Field>
        {cat.dates && (
          <div className="two">
            <Field label={category === 'justificatif' ? 'Absence du' : 'Arrêt du'}>
              <input className="in" id="doc-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} required={category !== 'justificatif'} />
            </Field>
            <Field label="Au" hint="Vide pour un seul jour.">
              <input className="in" id="doc-end" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Titre" hint="Facultatif : « Prolongation », « Recto verso »…">
          <input className="in" id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Note pour le gérant et la comptable">
          <input className="in" id="doc-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Facultatif" />
        </Field>
        {(category === 'arret' || category === 'accident') && (
          <p className="note">L'arrêt sera noté dans le planning à ces dates, et la comptable sera prévenue par e-mail. Garde l'original : il peut t'être demandé.</p>
        )}
        <p className="note">Seuls le gérant et la comptable verront ce document{forOther ? '' : ', avec toi'}. Les responsables et tes collègues, non.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Envoyer'}</button>
      </form>
    </Sheet>
  );
}

/** Tous les documents de l'équipe, par personne : pour la comptable (et le gérant, qui voit la même chose). */
export function TeamDocumentsView() {
  const q = useTeamDocuments(true);
  const [who, setWho] = useState('');
  if (q.isLoading) return <div className="list"><p className="empty"><Spinner /></p></div>;
  if (q.error) return <div className="list"><p className="empty err">{frError(q.error)}</p></div>;
  const people = q.data?.people ?? [];
  const docs = q.data?.documents ?? [];
  const name = new Map(people.map((p) => [p.id, `${p.first_name} ${p.last_name}`]));
  const recent = docs.slice(0, 8);
  const shown = who ? people.filter((p) => p.id === who) : people;
  return (
    <>
      {recent.length > 0 && (
        <Section title="Derniers documents reçus">
          <div className="list" data-testid="docs-recents">{recent.map((d) => <DocRow key={d.id} doc={d} who={name.get(d.profile_id)} />)}</div>
        </Section>
      )}
      <Field label="Personne">
        <select className="in" id="docs-who" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Toute l'équipe</option>
          {people.map((p) => (<option key={p.id} value={p.id}>{p.first_name} {p.last_name}{p.active ? '' : ' (ancien membre)'}</option>))}
        </select>
      </Field>
      {shown.map((p) => {
        const mine = docs.filter((d) => d.profile_id === p.id);
        const missing = ['identite', 'vitale', 'rib', 'dpae', 'contrat'].filter((c) => !mine.some((d) => d.category === c)) as DocCategory[];
        return (
          <Section key={p.id} title={`${p.first_name} ${p.last_name}`} right={p.folder_url ? <a className="link" href={p.folder_url} target="_blank" rel="noopener noreferrer">Dossier Drive</a> : undefined}>
            <div className="list" data-person-docs={`${p.first_name} ${p.last_name}`}>
              {mine.length === 0 && <p className="empty">Aucun document dans l'appli.</p>}
              {mine.map((d) => <DocRow key={d.id} doc={d} />)}
            </div>
            {p.active && missing.length > 0 && <p className="note">Pas encore dans l'appli : {missing.map((c) => DOC_LABEL[c].split(' (')[0].toLowerCase()).join(', ')}.</p>}
          </Section>
        );
      })}
      <p className="note">Les documents s'ouvrent dans un nouvel onglet ; le lien ne dure que deux minutes. Le dossier Drive s'ouvre seulement si le gérant te l'a partagé.</p>
    </>
  );
}

/** Supprimer un document (gérant) : la fiche, puis le fichier. */
export async function deleteDocument(doc: StaffDocument): Promise<string> {
  const { error } = await supabase.from('staff_documents').delete().eq('id', doc.id);
  if (error) return frError(error);
  await supabase.storage.from('staff-docs').remove([doc.file_path]);
  return '';
}
