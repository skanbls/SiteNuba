import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { DocRow, DocumentSheet, deleteDocument } from '../components/Documents';
import { Icon } from '../components/Icon';
import { RightsPicker } from '../components/Rights';
import { Avatar, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useAllRights, useFolders, useRefresh, useTeam, useTeamDocuments } from '../lib/data';
import { AREAS, type Area } from '../lib/rights';
import { useMe } from '../lib/session';
import { appUrl, frError, supabase } from '../lib/supabase';
import { CONTRACT_LABEL, ROLE_LABEL, fullName, type Contract, type Profile, type Role } from '../lib/types';

/** L'équipe : qui a accès à l'appli, avec quel rôle. Réservé au gérant. */
export default function Team() {
  const me = useMe();
  const toast = useToast();
  const team = useTeam();
  const rights = useAllRights(true);
  const folders = useFolders(true);
  const byProfile = useMemo(() => {
    const m = new Map<string, Area[]>();
    for (const r of rights.data ?? []) m.set(r.profile_id, [...(m.get(r.profile_id) ?? []), r.area as Area]);
    return m;
  }, [rights.data]);
  const folderOf = useMemo(() => new Map((folders.data ?? []).map((f) => [f.profile_id, f.url])), [folders.data]);
  const [edit, setEdit] = useState<Profile | 'new' | null>(null);
  const close = useCallback(() => setEdit(null), []);
  const list = team.data ?? [];
  const active = list.filter((p) => p.active);
  const inactive = list.filter((p) => !p.active);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(appUrl());
      toast("Lien de l'appli copié");
    } catch {
      toast(appUrl());
    }
  }

  const row = (p: Profile) => (
    <button type="button" className="row wrap" key={p.id} onClick={() => setEdit(p)}>
      <Avatar p={p} />
      <div className="grow">
        <span className="t">{fullName(p)}{p.id === me.id ? ' (toi)' : ''}</span>
        <span className="sub">{[p.job, ROLE_LABEL[p.role], p.contract === 'extra' ? 'Extra' : `${String(p.weekly_hours).replace('.', ',')} h par semaine`].filter(Boolean).join(' · ')}</span>
        {p.role === 'responsable' && (
          <span className="sub">{byProfile.get(p.id)?.length ? `Gère : ${AREAS.filter(([a]) => byProfile.get(p.id)?.includes(a)).map(([, l]) => l).join(', ')}` : 'Ne modifie rien pour l\'instant'}</span>
        )}
      </div>
      <div className="end">
        {!p.active ? <span className="pill">Désactivé</span>
          : p.user_id ? <span className="pill ok">Compte actif</span>
          : p.email ? <span className="pill warn">En attente d'inscription</span>
          : p.has_pin ? <span className="pill ok">iPad, avec code PIN</span>
          : <span className="pill bad">Aucun accès</span>}
        <span className="chev"><Icon name="chev" size={18} /></span>
      </div>
    </button>
  );

  return (
    <Layout title="Équipe" right={<button type="button" className="btn sm pri" onClick={() => setEdit('new')}><Icon name="plus" size={16} />Ajouter</button>}>
      <Section>
        {team.isLoading ? <Loading /> : <div className="list">{active.map(row)}</div>}
        <p className="note">
          Pour rejoindre l'appli, chaque personne ouvre le lien de l'appli et crée son compte avec l'adresse e-mail enregistrée ici. Son compte se rattache alors tout seul à sa fiche.
        </p>
        <div className="acts">
          <button type="button" className="btn" onClick={() => void copyLink()}><Icon name="copy" />Copier le lien de l'appli</button>
          <Link className="btn" to="/installer"><Icon name="qr" />QR code d'installation</Link>
          <Link className="btn" to="/guide"><Icon name="help" />Guide pour l'équipe</Link>
        </div>
      </Section>
      {inactive.length > 0 && (
        <Section title="Anciens membres">
          <div className="list">{inactive.map(row)}</div>
        </Section>
      )}
      {edit && <MemberSheet member={edit} self={edit !== 'new' && edit.id === me.id} areas={edit === 'new' ? [] : byProfile.get(edit.id) ?? []} folder={edit === 'new' ? '' : folderOf.get(edit.id) ?? ''} onClose={close} />}
    </Layout>
  );
}

function MemberSheet({ member, self, areas: oldAreas, folder: oldFolder, onClose }: { member: Profile | 'new'; self: boolean; areas: Area[]; folder: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = member === 'new' ? null : member;
  const [first, setFirst] = useState(old?.first_name ?? '');
  const [last, setLast] = useState(old?.last_name ?? '');
  const [email, setEmail] = useState(old?.email ?? '');
  const [role, setRole] = useState<Role>(old?.role ?? 'equipier');
  const [job, setJob] = useState(old?.job ?? '');
  const [contract, setContract] = useState<Contract>(old?.contract ?? 'cdi');
  const [hours, setHours] = useState(String(old?.weekly_hours ?? 35));
  const [pin, setPin] = useState('');
  const [areas, setAreas] = useState<Area[]>(oldAreas);
  const [folder, setFolder] = useState(oldFolder);
  const [id, setId] = useState(old?.id ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('team');
    toast(done);
    onClose();
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const h = Number(hours.replace(',', '.'));
    if (!(h >= 0 && h <= 60)) return setErr('Heures par semaine : entre 0 et 60.');
    if (pin && !/^\d{4}$/.test(pin)) return setErr('Le code PIN a 4 chiffres.');
    if (!old && !email.trim() && !pin) return setErr("Indique une adresse e-mail, ou donne un code PIN pour l'iPad.");
    const url = folder.trim();
    if (url && !/^https:\/\/\S+$/.test(url)) return setErr('Le lien du dossier doit commencer par https://');
    const rightsChanged = role === 'responsable' && [...areas].sort().join() !== [...oldAreas].sort().join();
    const row = { first_name: first, last_name: last, email: email.trim() || null, role, job, contract, weekly_hours: h };
    setBusy(true);
    setErr('');
    const saved = id
      ? await supabase.from('profiles').update(row).eq('id', id).select('id').single()
      : await supabase.from('profiles').insert(row).select('id').single();
    let error = saved.error;
    if (!error) {
      const savedId = (saved.data as { id: string }).id;
      setId(savedId);
      if (pin) error = (await supabase.rpc('set_member_pin', { p_profile: savedId, p_pin: pin })).error;
      if (!error && rightsChanged) error = (await supabase.rpc('set_rights', { p_profile: savedId, p_areas: areas })).error;
      if (!error && url !== oldFolder) {
        error = url
          ? (await supabase.from('profile_folders').upsert({ profile_id: savedId, url, updated_at: new Date().toISOString() })).error
          : (await supabase.from('profile_folders').delete().eq('profile_id', savedId)).error;
      }
    }
    setBusy(false);
    if (error) {
      await refresh('team', 'rights', 'folders');
      return setErr(frError(error));
    }
    await refresh('team', 'rights', 'folders');
    toast(old ? 'Fiche enregistrée' : email.trim() ? `${first.trim()} peut maintenant créer son compte avec cette adresse` : `${first.trim()} peut utiliser l'iPad avec son code PIN`);
    onClose();
  }

  return (
    <Sheet title={old ? fullName(old) : 'Ajouter une personne'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <div className="two">
          <Field label="Prénom">
            <input className="in" id="m-first" value={first} onChange={(e) => setFirst(e.target.value)} required />
          </Field>
          <Field label="Nom">
            <input className="in" id="m-last" value={last} onChange={(e) => setLast(e.target.value)} />
          </Field>
        </div>
        <Field label="Adresse e-mail" hint={old?.user_id ? "Le compte est déjà créé avec cette adresse : elle ne se change plus ici." : "Pour créer son compte sur son téléphone. Facultative : sans adresse, la personne utilise seulement l'iPad, avec son code PIN."}>
          <input className="in" id="m-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!old?.user_id} />
        </Field>
        <Field label="Code PIN pour l'iPad" hint={old?.has_pin ? 'Un code existe déjà. Remplis ce champ seulement pour le remplacer.' : "4 chiffres. Facultatif : chacun peut aussi le choisir dans Mon compte."}>
          <input className="in" id="m-pin" inputMode="numeric" autoComplete="off" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={old?.has_pin ? '••••' : ''} />
        </Field>
        <div className="two">
          <Field label="Rôle" hint={role === 'gerant' ? "Accès à tout, y compris l'administration." : role === 'responsable' ? "Voit les pointages de l'équipe, affiche le QR code, et modifie ce que tu lui confies ci-dessous." : 'Voit ses propres pointages.'}>
            <select className="in" id="m-role" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={self}>
              {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (<option key={r} value={r}>{ROLE_LABEL[r]}</option>))}
            </select>
          </Field>
          <Field label="Poste">
            <input className="in" id="m-job" value={job} onChange={(e) => setJob(e.target.value)} placeholder="Serveur, barman…" />
          </Field>
        </div>
        <div className="two">
          <Field label="Contrat">
            <select className="in" id="m-contract" value={contract} onChange={(e) => setContract(e.target.value as Contract)}>
              {(Object.keys(CONTRACT_LABEL) as Contract[]).map((c) => (<option key={c} value={c}>{CONTRACT_LABEL[c]}</option>))}
            </select>
          </Field>
          <Field label="Heures par semaine">
            <input className="in" id="m-hours" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
        </div>
        {role === 'responsable' && (
          <div className="field">
            <span>Ce que cette personne peut modifier</span>
            <RightsPicker value={areas} onChange={setAreas} />
            <p className="note">Valable avec son compte, sur son téléphone ou sur l'iPad après connexion par e-mail. Avec le code PIN de l'iPad, elle a les droits d'un équipier.</p>
          </div>
        )}
        <Field label="Dossier Drive" hint="Lien du dossier où tu ranges ses autres documents. Toi et la comptable le voyez ; elle l'ouvre si tu lui partages le dossier dans Google Drive.">
          <input className="in" id="m-folder" type="url" inputMode="url" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="https://drive.google.com/…" />
        </Field>
        {oldFolder && <a className="btn" href={oldFolder} target="_blank" rel="noopener noreferrer"><Icon name="doc" />Ouvrir son dossier</a>}
        {old && <MemberDocuments member={old} />}
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && !self && (
          <div className="acts">
            <button type="button" className="btn" disabled={busy}
              onClick={() => void run(() => supabase.from('profiles').update({ active: !old.active }).eq('id', old.id), old.active ? 'Accès désactivé' : 'Accès réactivé')}>
              {old.active ? "Désactiver l'accès" : "Réactiver l'accès"}
            </button>
            {!old.user_id && (
              <button type="button" className="btn no" disabled={busy}
                onClick={() => void run(() => supabase.from('profiles').delete().eq('id', old.id), 'Fiche supprimée')}>
                Supprimer la fiche
              </button>
            )}
          </div>
        )}
        {old && !self && <p className="note">Désactiver coupe l'accès à l'appli et conserve les pointages. Une fiche sans compte peut être supprimée.</p>}
      </form>
    </Sheet>
  );
}

/** Documents d'une personne dans l'appli : le gérant les voit, en ajoute (DPAE, contrat…) et en retire. */
function MemberDocuments({ member }: { member: Profile }) {
  const toast = useToast();
  const refresh = useRefresh();
  const q = useTeamDocuments(true);
  const [adding, setAdding] = useState(false);
  const docs = (q.data?.documents ?? []).filter((d) => d.profile_id === member.id);
  return (
    <div className="field">
      <span>Ses documents dans l'appli</span>
      <div className="list" data-testid="membre-documents">
        {q.isLoading ? <p className="empty"><Spinner /></p> : docs.length === 0 ? <p className="empty">Aucun document.</p> : docs.map((d) => (
          <DocRow key={d.id} doc={d} onDelete={() => void deleteDocument(d).then(async (e) => { if (e) toast(e, 'bad'); else { await refresh('documents'); toast('Document supprimé'); } })} />
        ))}
      </div>
      <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}><Icon name="plus" size={16} />Ajouter un document</button>
      <small>Arrêts de travail, pièce d'identité, carte Vitale, DPAE, contrat… La comptable les voit aussi ; les responsables, non.</small>
      {adding && <DocumentSheet profileId={member.id} name={fullName(member)} forOther category="dpae" onClose={() => setAdding(false)} />}
    </div>
  );
}
