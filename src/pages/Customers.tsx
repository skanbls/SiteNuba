import { useCallback, useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { Chips, Field, Layout, Loading, Sheet, Spinner, useToast } from '../components/ui';
import { useCustomers, useRefresh } from '../lib/data';
import { frError, supabase } from '../lib/supabase';
import { CUSTOMER_KIND, type Customer, type CustomerKind } from '../lib/types';
import { useCan } from '../lib/rights';

type Filter = 'tous' | CustomerKind;
const KINDS = Object.keys(CUSTOMER_KIND) as CustomerKind[];

/** Fichier clients : particuliers, entreprises, artistes, prestataires. */
export default function Customers() {
  const can = useCan();
  const editor = can('evenements');
  const customers = useCustomers();
  const [filter, setFilter] = useState<Filter>('tous');
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Customer | 'new' | null>(null);
  const close = useCallback(() => setEdit(null), []);
  const needle = search.trim().toLowerCase();
  const shown = (customers.data ?? [])
    .filter((c) => c.active || editor)
    .filter((c) => filter === 'tous' || c.kind === filter)
    .filter((c) => !needle || [c.name, c.company, c.phone, c.email].some((v) => v.toLowerCase().includes(needle)));

  return (
    <Layout title="Clients" right={<button type="button" className="btn sm pri" onClick={() => setEdit('new')}><Icon name="plus" size={16} />Fiche</button>}>
      <input className="in" id="cust-search" type="search" placeholder="Chercher un nom, une société, un téléphone" aria-label="Chercher" value={search} onChange={(e) => setSearch(e.target.value)} />
      <Chips value={filter} options={[['tous', 'Tous'], ...KINDS.map((k) => [k, CUSTOMER_KIND[k] + 's'] as [Filter, string])]} onChange={setFilter} label="Type" />
      {customers.isLoading ? <Loading /> : customers.error ? <div className="list"><p className="empty err">{frError(customers.error)}</p></div> : (
        <div className="list">
          {shown.length === 0 && <p className="empty">{(customers.data ?? []).length === 0 ? 'Aucune fiche pour l\'instant. Les demandes reçues en ligne créent la leur toutes seules.' : 'Aucune fiche ne correspond.'}</p>}
          {shown.map((c) => (
            <button type="button" className="row" key={c.id} data-customer={c.name} onClick={() => setEdit(c)} style={c.active ? undefined : { opacity: 0.6 }}>
              <span className="av" aria-hidden="true">{c.name[0]}</span>
              <span className="grow">
                <span className="t">{c.name}{c.company ? ` · ${c.company}` : ''}</span>
                <span className="sub">{[CUSTOMER_KIND[c.kind], c.phone, c.email].filter(Boolean).join(' · ')}</span>
                {c.note && <span className="sub">{c.note}</span>}
              </span>
              {!c.active && <span className="pill">Retirée</span>}
              <span className="chev"><Icon name="chev" size={18} /></span>
            </button>
          ))}
        </div>
      )}
      <p className="note">Ces coordonnées servent à l'équipe pour les réservations de groupe et les événements. Elles ne sont visibles que par l'équipe.</p>
      {edit && <CustomerSheet customer={edit} editor={editor} onClose={close} />}
    </Layout>
  );
}

function CustomerSheet({ customer, editor, onClose }: { customer: Customer | 'new'; editor: boolean; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = customer === 'new' ? null : customer;
  const [f, setF] = useState({ name: old?.name ?? '', kind: old?.kind ?? 'particulier', company: old?.company ?? '', phone: old?.phone ?? '', email: old?.email ?? '', note: old?.note ?? '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('customers');
    toast(done);
    onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void run(() => supabase.rpc('save_customer', { p_id: old?.id ?? null, p_name: f.name, p_kind: f.kind, p_company: f.company, p_phone: f.phone, p_email: f.email, p_note: f.note }), old ? 'Fiche enregistrée' : 'Fiche ajoutée');
  }

  return (
    <Sheet title={old ? old.name : 'Nouvelle fiche'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <div className="two">
          <Field label="Nom"><input className="in" id="cust-name" value={f.name} onChange={set('name')} required maxLength={100} /></Field>
          <Field label="Type"><select className="in" id="cust-kind" value={f.kind} onChange={set('kind')}>{KINDS.map((k) => (<option key={k} value={k}>{CUSTOMER_KIND[k]}</option>))}</select></Field>
        </div>
        <Field label="Société ou groupe"><input className="in" id="cust-company" value={f.company} onChange={set('company')} maxLength={100} /></Field>
        <div className="two">
          <Field label="Téléphone"><input className="in" id="cust-phone" type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} maxLength={30} /></Field>
          <Field label="Adresse e-mail"><input className="in" id="cust-email" type="email" value={f.email} onChange={set('email')} maxLength={120} /></Field>
        </div>
        <Field label="Note"><textarea className="in" id="cust-note" value={f.note} onChange={set('note')} maxLength={1000} placeholder="Habitudes, allergies, tarif convenu…" /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && editor && (
          <button type="button" className="btn block" disabled={busy}
            onClick={() => void run(() => supabase.from('customers').update({ active: !old.active }).eq('id', old.id), old.active ? 'Fiche retirée' : 'Fiche rétablie')}>
            {old.active ? 'Retirer cette fiche' : 'Rétablir cette fiche'}
          </button>
        )}
      </form>
    </Sheet>
  );
}
