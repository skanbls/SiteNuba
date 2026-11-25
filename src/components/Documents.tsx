import { useState, type FormEvent } from 'react';
import { Icon } from './Icon';
import { Field, Section, Sheet, Spinner, useToast } from './ui';
import { documentUrl, fileProblem, lastMonth, monthLabel, removePayslip, sendDocument } from '../lib/documents';
import { useDriveFiles, useDriveSource, useRefresh, useTeamDocuments, type TeamDocuments } from '../lib/data';
import { driveTree, fmtSize, type DriveFile, type DriveNode } from '../lib/driveTree';
import { frError, supabase } from '../lib/supabase';
import { ago, fmtDate } from '../lib/time';
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

/* ---------- Dossier des salariés : la copie du Drive, même arborescence ---------- */

/** Télécharge un fichier sous son nom d'origine (lien valable deux minutes). */
function DriveDownload({ file }: { file: DriveFile }) {
  const toast = useToast();
  const [link, setLink] = useState('');
  async function go() {
    // Fenêtre ouverte tout de suite, au toucher : sinon l'iPhone la bloque.
    const w = window.open('', '_blank');
    try {
      // Le nom d'origine, encodé une seule fois (supabase-js l'encode deux fois : les accents seraient abîmés).
      const url = `${await documentUrl(file.storage_path!)}&download=${encodeURIComponent(file.name)}`;
      if (w) w.location.href = url;
      else setLink(url);
    } catch (e) {
      w?.close();
      toast(frError(e), 'bad');
    }
  }
  return link
    ? <a className="btn sm pri" href={link} target="_blank" rel="noopener noreferrer" onClick={() => setLink('')}>Enregistrer</a>
    : <button type="button" className="btn sm" onClick={() => void go()} aria-label={`Télécharger ${file.name}`}><Icon name="down" size={16} />Télécharger</button>;
}

function DriveFileRow({ file }: { file: DriveFile }) {
  return (
    <div className="row wrap" data-drive-file={file.name}>
      <span className="drive-ico"><Icon name="doc" size={18} /></span>
      <span className="grow">
        <span className="t" style={{ overflowWrap: 'anywhere' }}>{file.name}</span>
        <span className="sub">{[`modifié le ${fmtDate(file.modified_at)}`, fmtSize(file.size)].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="end">
        {file.storage_path ? <DriveDownload file={file} /> : <span className="pill warn">Copie en cours</span>}
      </span>
    </div>
  );
}

function DriveItems({ node }: { node: DriveNode }) {
  return (
    <>
      {node.folders.map((f) => (
        <details className="drive-folder" key={f.name} data-folder={f.path.join(' / ')}>
          <summary className="row">
            <span className="drive-ico"><Icon name="folder" size={18} /></span>
            <span className="grow t">{f.name}</span>
            <span className="end"><span className="sub num">{f.count} fichier{f.count > 1 ? 's' : ''}</span><span className="chev"><Icon name="chev" size={16} /></span></span>
          </summary>
          <div className="drive-in"><DriveItems node={f} /></div>
        </details>
      ))}
      {node.files.map((f) => <DriveFileRow key={f.id} file={f} />)}
    </>
  );
}

/**
 * Le dossier des salariés, copié du Drive avec la même arborescence (gérant et comptable).
 * Avec `profileId` : le dossier de cette personne seulement, sans répéter son nom.
 */
export function DriveTree({ profileId }: { profileId?: string }) {
  const q = useDriveFiles(true);
  const src = useDriveSource(true);
  if (q.isLoading) return <div className="list"><p className="empty"><Spinner /></p></div>;
  const files = (q.data ?? []).filter((f) => !profileId || f.profile_id === profileId);
  if (profileId && files.length === 0) return null;
  if (!src.data?.synced_at && files.length === 0) {
    return <p className="note" data-testid="drive-vide">Le dossier des salariés du Drive n'est pas encore copié ici : le gérant le relie dans Administration.</p>;
  }
  const tree = driveTree(files, profileId ? 1 : 0);
  return (
    <>
      <div className="list" data-testid={profileId ? 'drive-personne' : 'drive-tree'}>
        {tree.count === 0 ? <p className="empty">Aucun fichier dans le dossier.</p> : <DriveItems node={tree} />}
      </div>
      {!profileId && src.data?.synced_at && (
        <p className="note">Copie du Drive, mise à jour {ago(src.data.synced_at)} et toute seule ensuite (toutes les dix minutes). Un fichier ajouté, modifié ou retiré dans le Drive l'est ici aussi.</p>
      )}
    </>
  );
}

/** Une ligne de document : catégorie, dates, date d'envoi. */
export function DocRow({ doc, who, onDelete }: { doc: StaffDocument; who?: string; onDelete?: () => void }) {
  const payslip = doc.category === 'paie' && !!doc.start_date;
  const dates = payslip ? '' : doc.start_date ? (doc.end_date && doc.end_date !== doc.start_date ? `du ${day(doc.start_date)} au ${day(doc.end_date)}` : `le ${day(doc.start_date)}`) : '';
  return (
    <div className="row wrap" data-doc={DOC_LABEL[doc.category]} data-month={payslip ? doc.start_date!.slice(0, 7) : undefined}>
      <span className="grow">
        <span className="t">{who ? `${who} · ` : ''}{DOC_LABEL[doc.category]}{payslip ? ` · ${monthLabel(doc.start_date!)}` : ''}</span>
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
  const [month, setMonth] = useState(lastMonth);
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
    if (cat.month && !/^\d{4}-\d{2}$/.test(month)) return setErr('Choisis le mois du bulletin.');
    const problem = await sendDocument(file!, profileId, cat.month
      ? { category, title, start: `${month}-01`, end: '', note }
      : { category, title, start: cat.dates ? start : '', end: cat.dates ? end : '', note });
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
        {cat.month && (
          <Field label="Mois du bulletin">
            <input className="in" id="doc-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
          </Field>
        )}
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
        <p className="note">{cat.month ? 'Le salarié le retrouve dans Mon compte et reçoit un e-mail.' : `Seuls le gérant et la comptable verront ce document${forOther ? '' : ', avec toi'}. Les responsables et tes collègues, non.`}</p>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Envoyer'}</button>
      </form>
    </Sheet>
  );
}

/** Tous les documents de l'équipe, par personne : pour la comptable (et le gérant, qui voit la même chose). */
/** Ce qui, dans le dossier Drive d'une personne, tient lieu d'un document attendu. */
const DRIVE_HINT: Partial<Record<DocCategory, RegExp>> = {
  identite: /identite|passeport|\bcni\b|sejour/, vitale: /vitale|securite sociale/, rib: /\brib\b|bancaire/, dpae: /dpae/, contrat: /contrat|avenant/,
};
const plain = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function TeamDocumentsView({ accountantId }: { accountantId?: string }) {
  const q = useTeamDocuments(true);
  const drive = useDriveFiles(true);
  const toast = useToast();
  const refresh = useRefresh();
  const [who, setWho] = useState('');
  const [deposit, setDeposit] = useState(false);
  if (q.isLoading) return <div className="list"><p className="empty"><Spinner /></p></div>;
  if (q.error) return <div className="list"><p className="empty err">{frError(q.error)}</p></div>;
  const people = q.data?.people ?? [];
  const docs = q.data?.documents ?? [];
  const name = new Map(people.map((p) => [p.id, `${p.first_name} ${p.last_name}`]));
  const recent = docs.slice(0, 8);
  const shown = who ? people.filter((p) => p.id === who) : people;
  const remove = (d: StaffDocument) => async () => {
    const e = await removePayslip(d.id);
    if (e) return toast(frError({ message: e }), 'bad');
    await refresh('documents');
    toast('Bulletin retiré');
  };
  const own = (d: StaffDocument) => !!accountantId && d.category === 'paie' && d.accountant_id === accountantId ? remove(d) : undefined;
  const inDrive = (profileId: string, c: DocCategory) => (drive.data ?? []).some((f) => f.profile_id === profileId && DRIVE_HINT[c]?.test(plain([...f.folder, f.name].join(' '))));
  return (
    <>
      <div className="acts">
        <button type="button" className="btn pri" onClick={() => setDeposit(true)}><Icon name="down" />Déposer les bulletins de paie</button>
      </div>
      {deposit && q.data && <PayslipSheet team={q.data} onClose={() => setDeposit(false)} />}
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
      <Section title={who ? `Dossier Drive de ${name.get(who) ?? ''}` : 'Dossier des salariés (Drive)'}>
        <DriveTree key={who} profileId={who || undefined} />
        {who && <DrivePersonEmpty profileId={who} />}
      </Section>
      {shown.map((p) => {
        const mine = docs.filter((d) => d.profile_id === p.id);
        const missing = (['identite', 'vitale', 'rib', 'dpae', 'contrat'] as DocCategory[]).filter((c) => !mine.some((d) => d.category === c) && !inDrive(p.id, c));
        return (
          <Section key={p.id} title={`${p.first_name} ${p.last_name}`} right={p.folder_url ? <a className="link" href={p.folder_url} target="_blank" rel="noopener noreferrer">Dossier Drive</a> : undefined}>
            <div className="list" data-person-docs={`${p.first_name} ${p.last_name}`}>
              {mine.length === 0 && <p className="empty">Aucun document dans l'appli.</p>}
              {mine.map((d) => <DocRow key={d.id} doc={d} onDelete={own(d)} />)}
            </div>
            {p.active && missing.length > 0 && <p className="note">Ni dans l'appli ni dans son dossier Drive : {missing.map((c) => DOC_LABEL[c].split(' (')[0].toLowerCase()).join(', ')}.</p>}
          </Section>
        );
      })}
      <p className="note">Les documents s'ouvrent ou se téléchargent dans un nouvel onglet ; le lien ne dure que deux minutes. Le lien « Dossier Drive » ouvre le Drive lui-même, seulement si le gérant te l'a partagé.</p>
    </>
  );
}

/** Rien dans le Drive pour cette personne : on le dit, plutôt qu'une rubrique vide. */
function DrivePersonEmpty({ profileId }: { profileId: string }) {
  const q = useDriveFiles(true);
  if (q.isLoading || (q.data ?? []).some((f) => f.profile_id === profileId)) return null;
  return <p className="note">Aucun dossier Drive reconnu pour cette personne : son dossier doit porter son prénom et son nom, ou son lien doit être dans sa fiche.</p>;
}

/** Supprimer un document (gérant) : la fiche, puis le fichier. */
export async function deleteDocument(doc: StaffDocument): Promise<string> {
  const { error } = await supabase.from('staff_documents').delete().eq('id', doc.id);
  if (error) return frError(error);
  await supabase.storage.from('staff-docs').remove([doc.file_path]);
  return '';
}

/**
 * Déposer les bulletins d'un mois : une ligne par salarié, un PDF chacun.
 * Chaque salarié reçoit un e-mail et retrouve son bulletin dans Mon compte.
 */
export function PayslipSheet({ team, onClose }: { team: TeamDocuments; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [month, setMonth] = useState(lastMonth);
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const people = team.people.filter((p) => p.active);
  const has = (id: string) => team.documents.some((d) => d.profile_id === id && d.category === 'paie' && d.start_date?.slice(0, 7) === month);
  const chosen = people.filter((p) => files[p.id]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    const out: Record<string, string> = {};
    let ok = 0;
    for (const p of chosen) {
      const f = files[p.id]!;
      const bad = f.type && f.type !== 'application/pdf' ? 'Envoie le bulletin en PDF.' : fileProblem(f);
      if (bad) { out[p.id] = bad; continue; }
      setBusy(`${p.first_name} ${p.last_name}`);
      const problem = await sendDocument(f, p.id, { category: 'paie', title: '', start: `${month}-01`, end: '', note: '' });
      if (problem) out[p.id] = frError({ message: problem });
      else ok += 1;
    }
    setBusy('');
    setErrs(out);
    await refresh('documents');
    if (ok) toast(`${ok} bulletin${ok > 1 ? 's' : ''} de ${monthLabel(`${month}-01`)} déposé${ok > 1 ? 's' : ''}`);
    if (!Object.keys(out).length) onClose();
    else setFiles((f) => Object.fromEntries(Object.entries(f).filter(([id]) => out[id])));
  }

  return (
    <Sheet title="Déposer les bulletins de paie" onClose={onClose}>
      <form className="form" onSubmit={send}>
        <Field label="Mois des bulletins">
          <input className="in" id="paie-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
        </Field>
        <div className="list" data-testid="paie-salaries">
          {people.length === 0 && <p className="empty">Aucun salarié dans l'équipe.</p>}
          {people.map((p) => (
            <div className="row wrap" key={p.id} data-paie={`${p.first_name} ${p.last_name}`}>
              <span className="grow">
                <span className="t">{p.first_name} {p.last_name}</span>
                {has(p.id) && <span className="sub">Un bulletin de {monthLabel(`${month}-01`)} est déjà déposé.</span>}
                {errs[p.id] && <span className="sub err">{errs[p.id]}</span>}
              </span>
              <span className="end" style={{ flex: '1 1 220px' }}>
                <input className="in" type="file" accept="application/pdf" aria-label={`Bulletin de ${p.first_name} ${p.last_name}`}
                  onChange={(e) => setFiles((f) => ({ ...f, [p.id]: e.target.files?.[0] ?? null }))} />
              </span>
            </div>
          ))}
        </div>
        <p className="note">Un PDF par salarié. Chacun retrouve le sien dans Mon compte, rubrique « Mes bulletins de paie », et reçoit un e-mail. Personne d'autre ne le voit, à part le gérant.</p>
        <button className="btn pri block" disabled={!!busy || chosen.length === 0}>
          {busy ? <><Spinner /> {busy}…</> : chosen.length ? `Déposer ${chosen.length} bulletin${chosen.length > 1 ? 's' : ''}` : 'Choisis au moins un bulletin'}
        </button>
      </form>
    </Sheet>
  );
}
