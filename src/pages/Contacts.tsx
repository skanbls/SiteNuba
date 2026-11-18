import { useCallback, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useContacts, useRefresh } from '../lib/data';
import { useMe, useSession } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { CONTACT_CATEGORY, type Contact, type ContactCategory } from '../lib/types';

const ORDER: ContactCategory[] = ['urgence', 'equipe', 'depannage', 'fournisseur', 'administratif', 'autre'];
const IDEAS: [string, ContactCategory][] = [
  ['Gérant', 'equipe'], ['Responsable de salle', 'equipe'], ['Plombier', 'depannage'], ['Électricien', 'depannage'],
  ['Frigoriste (chambres froides)', 'depannage'], ['Dépannage hotte et extraction', 'depannage'], ['Alarme et télésurveillance', 'depannage'],
  ['Assurance', 'administratif'], ['Propriétaire ou syndic', 'administratif'], ['Expert-comptable', 'administratif'],
];

/** Lien d'appel : chiffres et + seulement. */
const tel = (phone: string) => `tel:${phone.replace(/[^0-9+]/g, '')}`;

/**
 * Numéros utiles : toute l'équipe les lit et les appelle d'un geste.
 * Le gérant et les responsables, avec leur compte, les modifient (la base l'impose aussi).
 */
export default function Contacts() {
  const me = useMe();
  const { pin } = useSession();
  const editor = !pin && (me.role === 'gerant' || me.role === 'responsable');
  const contacts = useContacts();
  const [edit, setEdit] = useState<Contact | { name: string; category: ContactCategory } | null>(null);
  const close = useCallback(() => setEdit(null), []);
  const all = contacts.data ?? [];

  return (
    <Layout title="Numéros utiles" right={editor && <button type="button" className="btn sm pri" onClick={() => setEdit({ name: '', category: 'depannage' })}><Icon name="plus" size={16} />Numéro</button>}>
      {contacts.isLoading ? <Loading /> : contacts.error ? <div className="list"><p className="empty err">{frError(contacts.error)}</p></div> : (
        <>
          {all.length === 0 && <div className="list"><p className="empty">Aucun numéro pour l'instant.</p></div>}
          {ORDER.filter((c) => all.some((x) => x.category === c)).map((c) => (
            <Section key={c} title={CONTACT_CATEGORY[c]}>
              <div className="list">
                {all.filter((x) => x.category === c).map((x) => (
                  <div className="row wrap" key={x.id} data-contact={x.name}>
                    <div className="grow">
                      <span className="t">{x.name}{x.urgent && x.category !== 'urgence' && <span className="pill bad" style={{ marginLeft: 8 }}>Urgence</span>}</span>
                      {x.note && <span className="sub">{x.note}</span>}
                    </div>
                    <div className="end">
                      <a className={`btn sm ${x.urgent ? 'pri' : ''}`} href={tel(x.phone)} aria-label={`Appeler ${x.name}, ${x.phone}`}><Icon name="phone" size={16} /><span className="num">{x.phone}</span></a>
                      {editor && <button type="button" className="btn sm" onClick={() => setEdit(x)} aria-label={`Modifier ${x.name}`}><Icon name="cog" size={16} /></button>}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          ))}
          {editor ? (
            <Section title="Idées de numéros à ajouter">
              <div className="chips" style={{ flexWrap: 'wrap', overflow: 'visible' }}>
                {IDEAS.filter(([n]) => !all.some((x) => x.name.toLowerCase().startsWith(n.toLowerCase()))).map(([n, c]) => (
                  <button type="button" className="chip" key={n} onClick={() => setEdit({ name: n, category: c })}><Icon name="plus" size={16} />{n}</button>
                ))}
              </div>
              <p className="note">Toute l'équipe voit ces numéros, y compris sur l'iPad. Seuls le gérant et les responsables les modifient.</p>
            </Section>
          ) : (
            <p className="note">Touche un numéro pour l'appeler. Un numéro manque ou a changé ? Préviens le gérant ou ton responsable.</p>
          )}
        </>
      )}
      {edit && <ContactSheet contact={edit} onClose={close} />}
    </Layout>
  );
}

function ContactSheet({ contact, onClose }: { contact: Contact | { name: string; category: ContactCategory }; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = 'id' in contact ? contact : null;
  const [name, setName] = useState(contact.name);
  const [category, setCategory] = useState<ContactCategory>(contact.category);
  const [phone, setPhone] = useState(old?.phone ?? '');
  const [note, setNote] = useState(old?.note ?? '');
  const [urgent, setUrgent] = useState(old?.urgent ?? false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(/contacts_phone_check/.test(error.message) ? 'Vérifie le numéro : des chiffres, espaces, points ou +.' : frError(error));
    await refresh('contacts');
    toast(done);
    onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!/^[0-9+][0-9 .()+-]{1,24}$/.test(phone.trim())) return setErr('Vérifie le numéro : des chiffres, espaces, points ou +.');
    const row = { name: name.trim(), category, phone: phone.trim(), note: note.trim(), urgent };
    void (old ? run(() => supabase.from('contacts').update(row).eq('id', old.id), 'Numéro enregistré') : run(() => supabase.from('contacts').insert(row), 'Numéro ajouté'));
  }

  return (
    <Sheet title={old ? old.name : 'Ajouter un numéro'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Nom"><input className="in" id="ct-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Plombier Garcia, Sam (gérant)…" /></Field>
        <div className="two">
          <Field label="Numéro"><input className="in" id="ct-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required placeholder="06 12 34 56 78" /></Field>
          <Field label="Rubrique">
            <select className="in" id="ct-category" value={category} onChange={(e) => setCategory(e.target.value as ContactCategory)}>
              {ORDER.map((c) => (<option key={c} value={c}>{CONTACT_CATEGORY[c]}</option>))}
            </select>
          </Field>
        </div>
        <Field label="À savoir" hint="Quand l'appeler, horaires, numéro de contrat…"><input className="in" id="ct-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
        <label className="row" style={{ padding: 0, gap: 10 }}>
          <input id="ct-urgent" type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} style={{ width: 22, height: 22 }} />
          <span className="grow"><span className="t">Numéro d'urgence</span><span className="sub">Affiché en tête, avec un bouton d'appel bien visible.</span></span>
        </label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && <button type="button" className="btn no block" disabled={busy} onClick={() => void run(() => supabase.from('contacts').delete().eq('id', old.id), 'Numéro supprimé')}>Supprimer ce numéro</button>}
      </form>
    </Sheet>
  );
}
