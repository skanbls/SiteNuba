import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useOrders, useProducts, useRefresh, useSuppliers, useTeam } from '../lib/data';
import { frError, supabase } from '../lib/supabase';
import { fmtDateShort, fmtTime } from '../lib/time';
import { ORDER_LABEL, ORDER_PILL, toOrder, type Order, type Product, type Supplier } from '../lib/types';
import { qty } from './Stocks';
import { useCan } from '../lib/rights';

const euro = (v: number) => v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const when = (iso: string | null) => (iso ? `${fmtDateShort(new Date(iso))} à ${fmtTime(iso)}` : '');

/** Texte de la commande, à envoyer au fournisseur. */
function orderText(supplier: string, lines: { name: string; unit: string; quantity: number }[], note: string): string {
  return [`Bonjour,`, ``, `Commande de la Nuba pour ${supplier} :`, ...lines.map((l) => `- ${qty(l.quantity)} × ${l.name}${l.unit ? ` (${l.unit})` : ''}`), ...(note ? ['', note] : []), '', 'Merci.'].join('\n');
}
/** Numéro français ou international, sans espaces, pour un lien WhatsApp. */
const waNumber = (phone: string) => {
  const d = phone.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  return d.startsWith('0') ? `33${d.slice(1)}` : d;
};

/** Commandes aux fournisseurs : préparation à partir des seuils, envoi, réception. */
export default function Orders() {
  const can = useCan();
  const editor = can('stocks');
  const toast = useToast();
  const refresh = useRefresh();
  const products = useProducts();
  const suppliers = useSuppliers();
  const orders = useOrders();
  const team = useTeam();
  const who = useMemo(() => new Map((team.data ?? []).map((p) => [p.id, p.first_name])), [team.data]);
  const [openId, setOpenId] = useState('');
  const [picking, setPicking] = useState(false);
  const [editSupplier, setEditSupplier] = useState<Supplier | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const closeOrder = useCallback(() => setOpenId(''), []);
  const closePick = useCallback(() => setPicking(false), []);
  const closeSupplier = useCallback(() => setEditSupplier(null), []);

  const all = orders.data ?? [];
  const activeProducts = (products.data ?? []).filter((p) => p.active);
  const activeSuppliers = (suppliers.data ?? []).filter((s) => s.active);
  const onOrder = new Set(all.filter((o) => o.status === 'draft' || o.status === 'sent').flatMap((o) => o.order_lines.map((l) => l.product_id)));
  const needed = activeProducts.filter((p) => p.threshold > 0 && p.quantity < p.threshold && !onOrder.has(p.id));
  const groups = activeSuppliers.map((s) => ({ s, items: needed.filter((p) => p.supplier_id === s.id) })).filter((g) => g.items.length > 0);
  const orphans = needed.filter((p) => !p.supplier_id || !activeSuppliers.some((s) => s.id === p.supplier_id));
  const current = all.filter((o) => o.status === 'draft' || o.status === 'sent');
  const past = all.filter((o) => o.status === 'received' || o.status === 'cancelled').slice(0, 10);
  const open = all.find((o) => o.id === openId);

  async function create(supplierId: string, items: Product[]) {
    setBusy(true);
    const { data, error } = await supabase.rpc('save_order', { p_id: null, p_supplier: supplierId, p_note: '', p_lines: items.map((p) => ({ product_id: p.id, quantity: toOrder(p) })) });
    setBusy(false);
    if (error) return toast(frError(error), 'bad');
    await refresh('orders');
    setPicking(false);
    setOpenId(data as string);
  }

  const row = (o: Order) => (
    <button type="button" className="row wrap" key={o.id} onClick={() => setOpenId(o.id)} data-order={o.suppliers?.name}>
      <div className="grow">
        <span className="t">{o.suppliers?.name ?? 'Fournisseur supprimé'}</span>
        <span className="sub">{o.order_lines.length} produit{o.order_lines.length > 1 ? 's' : ''} · {o.status === 'draft' ? `préparée le ${when(o.created_at)}` : o.status === 'sent' ? `envoyée le ${when(o.sent_at)}` : o.status === 'received' ? `reçue le ${when(o.received_at)}` : 'annulée'}</span>
      </div>
      <div className="end">
        {o.status === 'received' && o.reception_ok === false && <span className="pill bad">Problème signalé</span>}
        <span className={`pill ${ORDER_PILL[o.status]}`}>{ORDER_LABEL[o.status]}</span>
        <span className="chev"><Icon name="chev" size={18} /></span>
      </div>
    </button>
  );

  if (orders.isLoading || products.isLoading || suppliers.isLoading) return <Layout title="Commandes"><Loading /></Layout>;
  const failed = orders.error ?? products.error ?? suppliers.error;
  if (failed) return <Layout title="Commandes"><div className="list"><p className="empty err">{frError(failed)}</p></div></Layout>;

  return (
    <Layout title="Commandes" right={activeSuppliers.length > 0 && <button type="button" className="btn sm pri" onClick={() => setPicking(true)}><Icon name="plus" size={16} />Commande</button>}>
      <Section title="À commander">
        {groups.length === 0 && orphans.length === 0 && <div className="list"><p className="empty">Rien à commander : tous les produits sont au-dessus de leur seuil, ou déjà en commande.</p></div>}
        {groups.map(({ s, items }) => (
          <div className="list" key={s.id} data-suggest={s.name}>
            <div className="row wrap">
              <div className="grow">
                <span className="t">{s.name}</span>
                <span className="sub">{[s.order_cutoff, s.delivery_days, s.minimum].filter(Boolean).join(' · ') || 'Aucune consigne notée'}</span>
              </div>
              <button type="button" className="btn sm pri" disabled={busy} onClick={() => void create(s.id, items)}>Préparer la commande</button>
            </div>
            {items.map((p) => (
              <div className="row" key={p.id}>
                <div className="grow">
                  <span className="t" style={{ fontWeight: 500 }}>{p.name}</span>
                  <span className="sub">en stock {qty(p.quantity)} · seuil {qty(p.threshold)}{p.unit ? ` · ${p.unit}` : ''}</span>
                </div>
                <span className="t num">{qty(toOrder(p))}</span>
              </div>
            ))}
          </div>
        ))}
        {orphans.length > 0 && (
          <div className="list">
            <div className="row"><div className="grow"><span className="t">Sans fournisseur</span><span className="sub">{editor ? 'Attribue un fournisseur à ces produits dans Stocks pour pouvoir les commander.' : 'Le gérant doit attribuer un fournisseur à ces produits.'}</span></div></div>
            {orphans.map((p) => (<div className="row" key={p.id}><div className="grow"><span className="t" style={{ fontWeight: 500 }}>{p.name}</span><span className="sub">en stock {qty(p.quantity)} · seuil {qty(p.threshold)}</span></div></div>))}
          </div>
        )}
      </Section>

      <div className="cols">
        <div className="stack">
          <Section title="Commandes en cours">
            <div className="list">
              {current.length === 0 && <p className="empty">Aucune commande en préparation ni en attente de livraison.</p>}
              {current.map(row)}
            </div>
          </Section>
          {past.length > 0 && (
            <Section title="Dernières commandes">
              <div className="list">{past.map(row)}</div>
            </Section>
          )}
        </div>

        <Section title="Fournisseurs" right={editor && <button type="button" className="link" onClick={() => setEditSupplier('new')}>Ajouter un fournisseur</button>}>
          <div className="list">
            {(suppliers.data ?? []).length === 0 && <p className="empty">{editor ? 'Aucun fournisseur. Ajoute le premier pour pouvoir commander.' : 'Aucun fournisseur pour l\'instant.'}</p>}
            {(suppliers.data ?? []).filter((s) => s.active || editor).map((s) => {
              const body = (
                <>
                  <div className="grow">
                    <span className="t">{s.name}{!s.active && <span className="pill" style={{ marginLeft: 8 }}>Retiré</span>}</span>
                    <span className="sub">{[s.contact, s.phone, s.email].filter(Boolean).join(' · ') || 'Aucun contact noté'}</span>
                    {(s.delivery_days || s.order_cutoff || s.minimum) && <span className="sub">{[s.delivery_days, s.order_cutoff, s.minimum].filter(Boolean).join(' · ')}</span>}
                  </div>
                  {editor && <span className="chev"><Icon name="chev" size={18} /></span>}
                </>
              );
              return editor ? <button type="button" className="row" key={s.id} onClick={() => setEditSupplier(s)}>{body}</button> : <div className="row" key={s.id}>{body}</div>;
            })}
          </div>
        </Section>
      </div>

      {open && <OrderSheet key={`${open.id}-${open.status}`} order={open} products={activeProducts} editor={editor} who={who} onClose={closeOrder} />}
      {picking && (
        <Sheet title="Nouvelle commande" onClose={closePick}>
          <p className="note">Choisis le fournisseur. Tu ajoutes ensuite les produits.</p>
          <div className="list">
            {activeSuppliers.map((s) => (
              <button type="button" className="row" key={s.id} disabled={busy} onClick={() => void create(s.id, needed.filter((p) => p.supplier_id === s.id))}>
                <span className="grow"><span className="t">{s.name}</span></span>
                <span className="chev"><Icon name="chev" size={18} /></span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {editSupplier && <SupplierSheet supplier={editSupplier} onClose={closeSupplier} />}
    </Layout>
  );
}

/* ---------- Une commande : brouillon, envoyée, reçue ---------- */
function OrderSheet({ order, products, editor, who, onClose }: { order: Order; products: Product[]; editor: boolean; who: Map<string, string>; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const navigate = useNavigate();
  const supplier = order.suppliers?.name ?? 'Fournisseur';
  const [lines, setLines] = useState(() => order.order_lines.map((l) => ({ product_id: l.product_id, name: l.products?.name ?? 'Produit', unit: l.products?.unit ?? '', quantity: l.quantity, price: l.unit_price })));
  const [note, setNote] = useState(order.note);
  const [add, setAdd] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const draft = order.status === 'draft';
  const text = orderText(supplier, lines, note.trim());
  const total = lines.reduce((t, l) => t + l.quantity * l.price, 0);
  const addable = products.filter((p) => !lines.some((l) => l.product_id === p.id)).sort((a, b) => Number(b.supplier_id === order.supplier_id) - Number(a.supplier_id === order.supplier_id) || a.name.localeCompare(b.name, 'fr'));

  const setQty = (id: string, q: number) => setLines((a) => a.map((l) => (l.product_id === id ? { ...l, quantity: Math.max(0, q) } : l)).filter((l) => l.quantity > 0));

  async function call(op: () => PromiseLike<{ error: { message: string } | null }>, done: string, close = true) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) {
      setErr(frError(error));
      return false;
    }
    await refresh('orders', 'products', 'tasks');
    if (done) toast(done);
    if (close) onClose();
    return true;
  }

  const save = () => supabase.rpc('save_order', { p_id: order.id, p_supplier: order.supplier_id, p_note: note, p_lines: lines.map((l) => ({ product_id: l.product_id, quantity: l.quantity })) });

  async function send() {
    if (lines.length === 0) return setErr('Ajoute au moins un produit.');
    setBusy(true);
    setErr('');
    const saved = await save();
    if (saved.error) {
      setBusy(false);
      return setErr(frError(saved.error));
    }
    await call(() => supabase.rpc('send_order', { p_id: order.id }), 'Commande notée comme envoyée');
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast('Texte de la commande copié');
    } catch {
      toast('Copie impossible sur cet appareil', 'bad');
    }
  }

  const share = (
    <div className="acts">
      <button type="button" className="btn sm" onClick={() => void copy()}><Icon name="copy" size={16} />Copier le texte</button>
      {order.suppliers?.email && <a className="btn sm" href={`mailto:${order.suppliers.email}?subject=${encodeURIComponent('Commande La Nuba')}&body=${encodeURIComponent(text)}`}>Par e-mail</a>}
      {order.suppliers?.phone && <a className="btn sm" target="_blank" rel="noreferrer" href={`https://wa.me/${waNumber(order.suppliers.phone)}?text=${encodeURIComponent(text)}`}>Par WhatsApp</a>}
    </div>
  );

  return (
    <Sheet title={`${supplier} · ${ORDER_LABEL[order.status].toLowerCase()}`} onClose={onClose}>
      {draft ? (
        <>
          <div className="list">
            {lines.length === 0 && <p className="empty">Aucun produit dans cette commande.</p>}
            {lines.map((l) => (
              <div className="row wrap" key={l.product_id} data-line={l.name}>
                <div className="grow"><span className="t">{l.name}</span><span className="sub">{l.unit}</span></div>
                <div className="step">
                  <button type="button" onClick={() => setQty(l.product_id, l.quantity - 1)} aria-label={`Commander 1 ${l.name} de moins`}><Icon name="minus" size={16} /></button>
                  <span className="qty" style={{ display: 'grid', placeItems: 'center', height: 40, padding: '0 8px' }}>{qty(l.quantity)}</span>
                  <button type="button" onClick={() => setQty(l.product_id, l.quantity + 1)} aria-label={`Commander 1 ${l.name} de plus`}><Icon name="plus" size={16} /></button>
                </div>
              </div>
            ))}
          </div>
          {addable.length > 0 && (
            <Field label="Ajouter un produit">
              <select className="in" id="order-add" value={add} onChange={(e) => {
                const p = products.find((x) => x.id === e.target.value);
                if (p) setLines((a) => [...a, { product_id: p.id, name: p.name, unit: p.unit, quantity: toOrder(p), price: p.unit_price }]);
                setAdd('');
              }}>
                <option value="">Choisir</option>
                {addable.map((p) => (<option key={p.id} value={p.id}>{p.name}{p.supplier_id !== order.supplier_id ? ' (autre fournisseur)' : ''}</option>))}
              </select>
            </Field>
          )}
          <Field label="Message pour le fournisseur">
            <input className="in" id="order-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Facultatif : heure de livraison souhaitée…" />
          </Field>
          <p className="sub">Total estimé : <b className="num">{euro(total)} HT</b></p>
          {share}
          {err && <p className="err" role="alert">{err}</p>}
          <div className="acts">
            <button type="button" className="btn" disabled={busy} onClick={() => void call(save, 'Brouillon enregistré')}>Enregistrer le brouillon</button>
            <button type="button" className="btn pri" disabled={busy} onClick={() => void send()}>{busy ? <Spinner /> : 'Commande envoyée'}</button>
          </div>
          <p className="note">Envoie d'abord le texte au fournisseur (copie, e-mail ou WhatsApp), puis touche « Commande envoyée » : elle passera en attente de livraison.</p>
          {confirm ? (
            <div className="acts">
              <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
              <button type="button" className="btn no" disabled={busy} onClick={() => void call(() => supabase.rpc('delete_order', { p_id: order.id }), 'Brouillon supprimé')}>Supprimer le brouillon</button>
            </div>
          ) : <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Supprimer ce brouillon</button>}
        </>
      ) : (
        <>
          <div className="list">
            {order.order_lines.map((l) => (
              <div className="row wrap" key={l.id} data-line={l.products?.name}>
                <div className="grow">
                  <span className="t">{l.products?.name ?? 'Produit'}</span>
                  <span className="sub">{l.products?.unit ? `${l.products.unit} · ` : ''}commandé : {qty(l.quantity)}{l.received_quantity !== null ? ` · reçu : ${qty(l.received_quantity)}` : ''}</span>
                </div>
                {l.received_quantity !== null && l.received_quantity < l.quantity ? <span className="pill warn">Incomplet</span> : null}
              </div>
            ))}
          </div>
          <p className="sub">
            Envoyée le {when(order.sent_at)} par {who.get(order.sent_by ?? '') ?? 'un ancien membre'}
            {order.status === 'received' && `. Reçue le ${when(order.received_at)} par ${who.get(order.received_by ?? '') ?? 'un ancien membre'}`}
          </p>
          {order.note && <p className="sub">Message : {order.note}</p>}
          {order.status === 'received' && (
            <div className="list">
              <div className="row">
                <div className="grow">
                  <span className="t">Contrôle à réception</span>
                  <span className="sub">{[order.reception_temp !== null ? `Température relevée : ${String(order.reception_temp).replace('.', ',')} °C` : '', order.reception_note].filter(Boolean).join(' · ') || 'Aucune remarque'}</span>
                </div>
                <span className={`pill ${order.reception_ok ? 'ok' : 'bad'}`}>{order.reception_ok ? 'Conforme' : 'Problème'}</span>
              </div>
            </div>
          )}
          {order.status === 'sent' && (
            <>
              {share}
              {/* La réception se fait dans Livraisons : photo du bon, lecture, écarts avec cette commande. */}
              <button type="button" className="btn pri block" onClick={() => { onClose(); navigate(`/livraisons?commande=${order.id}`); }}><Icon name="truck" />Réceptionner la livraison</button>
              {editor && (confirm ? (
                <div className="acts">
                  <button type="button" className="btn" onClick={() => setConfirm(false)}>Garder</button>
                  <button type="button" className="btn no" disabled={busy} onClick={() => void call(() => supabase.rpc('cancel_order', { p_id: order.id }), 'Commande annulée')}>Annuler la commande</button>
                </div>
              ) : <button type="button" className="btn no block" onClick={() => setConfirm(true)}>Cette commande ne sera pas livrée</button>)}
            </>
          )}
          {err && <p className="err" role="alert">{err}</p>}
        </>
      )}
    </Sheet>
  );
}

/* ---------- Fiche fournisseur (gérant) ---------- */
function SupplierSheet({ supplier, onClose }: { supplier: Supplier | 'new'; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = supplier === 'new' ? null : supplier;
  const [f, setF] = useState({
    name: old?.name ?? '', contact: old?.contact ?? '', phone: old?.phone ?? '', email: old?.email ?? '',
    delivery_days: old?.delivery_days ?? '', order_cutoff: old?.order_cutoff ?? '', minimum: old?.minimum ?? '', note: old?.note ?? '',
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('suppliers');
    toast(done);
    onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const row: Record<string, unknown> = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()]));
    void (old ? run(() => supabase.from('suppliers').update(row).eq('id', old.id), 'Fournisseur enregistré') : run(() => supabase.from('suppliers').insert(row), 'Fournisseur ajouté'));
  }

  return (
    <Sheet title={old ? old.name : 'Ajouter un fournisseur'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Nom"><input className="in" id="sup-name" value={f.name} onChange={set('name')} required maxLength={80} /></Field>
        <div className="two">
          <Field label="Personne à contacter"><input className="in" id="sup-contact" value={f.contact} onChange={set('contact')} maxLength={80} /></Field>
          <Field label="Téléphone" hint="Sert aussi au lien WhatsApp."><input className="in" id="sup-phone" type="tel" value={f.phone} onChange={set('phone')} maxLength={30} /></Field>
        </div>
        <Field label="Adresse e-mail"><input className="in" id="sup-email" type="email" value={f.email} onChange={set('email')} maxLength={120} /></Field>
        <div className="two">
          <Field label="Jours de livraison"><input className="in" id="sup-days" value={f.delivery_days} onChange={set('delivery_days')} placeholder="Mardi et vendredi" maxLength={80} /></Field>
          <Field label="Heure limite de commande"><input className="in" id="sup-cutoff" value={f.order_cutoff} onChange={set('order_cutoff')} placeholder="Avant 12 h la veille" maxLength={80} /></Field>
        </div>
        <div className="two">
          <Field label="Minimum de commande"><input className="in" id="sup-min" value={f.minimum} onChange={set('minimum')} placeholder="150 € HT" maxLength={60} /></Field>
          <Field label="Note"><input className="in" id="sup-note" value={f.note} onChange={set('note')} maxLength={200} /></Field>
        </div>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && (
          <button type="button" className="btn block" disabled={busy}
            onClick={() => void run(() => supabase.from('suppliers').update({ active: !old.active }).eq('id', old.id), old.active ? 'Fournisseur retiré' : 'Fournisseur réactivé')}>
            {old.active ? 'Retirer ce fournisseur' : 'Réactiver ce fournisseur'}
          </button>
        )}
      </form>
    </Sheet>
  );
}
