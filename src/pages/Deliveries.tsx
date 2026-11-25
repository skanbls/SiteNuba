import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ProductPicker, type Picked } from '../components/ProductPicker';
import { Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useDeliveries, useMercProducts, useOrders, useProducts, useSuppliers } from '../lib/data';
import { fmtQty, lineFlags, lineName, linesTotal, lineUnit, type Delivery, type DeliveryLine, type MercProduct } from '../lib/deliveries';
import type { Product } from '../lib/types';
import { resizePhoto } from '../lib/process';
import { frError, supabase } from '../lib/supabase';
import { dayKey, fmtDate, fmtDayLong, fmtTime } from '../lib/time';

const euro = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }));
const num = (s: string) => { const t = s.replace(/\s/g, '').replace(',', '.'); return t === '' ? null : Number(t); };
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
const serviceDay = () => dayKey(new Date(Date.now() - 5 * 3600_000));

/** Une photo en JPEG réduit, en base64 (sans l'en-tête data:). */
async function photoB64(file: Blob): Promise<{ mime: string; data: string }> {
  const small = await resizePhoto(file, 1800);
  const data = await new Promise<string>((ok, ko) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = ko; r.readAsDataURL(small); });
  return { mime: small.type === 'image/png' || small.type === 'image/webp' ? small.type : 'image/jpeg', data };
}

/**
 * Livraisons : la photo du bon, sa lecture, la vérification et la validation qui met le stock à jour.
 * Toute l'équipe, sur l'iPad (code PIN) comme sur le téléphone.
 */
export default function Deliveries() {
  const [params, setParams] = useSearchParams();
  const id = params.get('l');
  const orderId = params.get('commande');
  const toast = useToast();
  const opening = useRef('');

  // Depuis une commande : la réception est ouverte (ou reprise), puis affichée.
  useEffect(() => {
    if (!orderId || opening.current === orderId) return;
    opening.current = orderId;
    void supabase.rpc('delivery_open', { p_supplier: null, p_supplier_name: '', p_order: orderId }).then(({ data, error }) => {
      if (error) {
        toast(frError(error), 'bad');
        setParams({}, { replace: true });
      } else setParams({ l: (data as Delivery).id }, { replace: true });
    });
  }, [orderId, setParams, toast]);

  return (
    <Layout title="Livraisons">
      {orderId && !id ? <Loading /> : id ? <DeliveryView key={id} id={id} onBack={() => setParams({})} /> : <DeliveryHome onOpen={(d) => setParams({ l: d })} />}
    </Layout>
  );
}

/* ---------- Accueil : photographier un bon, commandes attendues, dernières livraisons ---------- */
function DeliveryHome({ onOpen }: { onOpen: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const orders = useOrders();
  const list = useDeliveries();
  const [supplier, setSupplier] = useState('');
  const [busy, setBusy] = useState(false);
  const expected = (orders.data ?? []).filter((o) => o.status === 'sent');

  async function open(order: string | null, file?: File) {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc('delivery_open', { p_supplier: order ? null : supplier || null, p_supplier_name: '', p_order: order });
      if (error) throw error;
      const d = data as Delivery;
      if (file) {
        const ph = await photoB64(file);
        const r = await supabase.rpc('delivery_add_photo', { p_id: d.id, p_mime: ph.mime, p_data: ph.data });
        if (r.error) throw r.error;
        // La lecture part tout de suite ; la page suit son avancement.
        await supabase.rpc('delivery_scan', { p_id: d.id });
      }
      await qc.invalidateQueries({ queryKey: ['deliveries'] });
      onOpen(d.id);
    } catch (e) {
      toast(frError(e), 'bad');
    } finally {
      setBusy(false);
    }
  }

  if (list.data === null) {
    return <div className="list"><p className="empty err">Les livraisons attendent la mise à jour 0029 de la base : le gérant doit l'exécuter dans Supabase.</p></div>;
  }
  const drafts = (list.data ?? []).filter((d) => d.status === 'draft');
  const done = (list.data ?? []).filter((d) => d.status === 'done');
  return (
    <>
      <div className="hero" data-testid="delivery-start">
        <p>Une livraison arrive ?</p>
        <p className="big" style={{ fontSize: 22 }}>Photographie le bon de livraison</p>
        <p>L'appli le lit, retrouve les produits et la commande, et montre ce qui ne colle pas.</p>
        <label className="btn" style={{ position: 'relative' }}>
          {busy ? <Spinner /> : <><Icon name="cam" />Photographier le bon</>}
          <input id="bl-photo" type="file" accept="image/*" capture="environment" disabled={busy}
            style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void open(null, f); }} />
        </label>
      </div>
      <Field label="Fournisseur (facultatif)" hint="Sinon, l'appli le lit sur le bon.">
        <select className="in" id="bl-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
          <option value="">Lu sur le bon</option>
          {(suppliers.data ?? []).filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Field>
      <button type="button" className="btn block" disabled={busy} onClick={() => void open(null)}>Saisir sans photo</button>

      {expected.length > 0 && (
        <Section title="Commandes attendues">
          <div className="list">
            {expected.map((o) => (
              <button type="button" className="row" key={o.id} data-expected={o.suppliers?.name} disabled={busy} onClick={() => void open(o.id)}>
                <span className="grow"><span className="t">{o.suppliers?.name ?? 'Fournisseur'}</span>
                  <span className="sub">{o.order_lines.length} produit{o.order_lines.length > 1 ? 's' : ''} · envoyée {o.sent_at ? `le ${fmtDate(o.sent_at)}` : ''}</span></span>
                <span className="end"><span className="pill info">Réceptionner</span><span className="chev"><Icon name="chev" size={18} /></span></span>
              </button>
            ))}
          </div>
        </Section>
      )}
      {drafts.length > 0 && (
        <Section title="À finir">
          <div className="list">
            {drafts.map((d) => (
              <button type="button" className="row" key={d.id} data-delivery={d.supplier_name || 'Livraison'} onClick={() => onOpen(d.id)}>
                <span className="grow"><span className="t">{d.supplier_name || 'Fournisseur à préciser'}</span>
                  <span className="sub">Commencée {fmtDayLong(d.created_at)} à {fmtTime(d.created_at)}{d.scan_status === 'pending' ? ' · lecture en cours' : ''}</span></span>
                <span className="end"><span className="pill warn">À valider</span><span className="chev"><Icon name="chev" size={18} /></span></span>
              </button>
            ))}
          </div>
        </Section>
      )}
      <Section title="Dernières livraisons">
        <div className="list">
          {list.isLoading && <p className="empty"><Spinner /></p>}
          {!list.isLoading && done.length === 0 && <p className="empty">Aucune livraison réceptionnée pour l'instant.</p>}
          {done.map((d) => (
            <button type="button" className="row" key={d.id} data-delivery={d.supplier_name || 'Livraison'} onClick={() => onOpen(d.id)}>
              <span className="grow"><span className="t">{d.supplier_name || 'Fournisseur'}</span>
                <span className="sub">{d.received_at ? `${fmtDayLong(d.received_at)} à ${fmtTime(d.received_at)}` : ''}{d.bl_number ? ` · BL ${d.bl_number}` : ''}</span></span>
              <span className="end">
                {d.ok === false ? <span className="pill bad">Problème</span> : d.issues.length > 0 ? <span className="pill warn">{d.issues.length} écart{d.issues.length > 1 ? 's' : ''}</span> : <span className="pill ok">Conforme</span>}
                <span className="chev"><Icon name="chev" size={18} /></span>
              </span>
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}

/* ---------- Une livraison : photos, lecture, lignes, contrôle, validation ---------- */
function DeliveryView({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const products = useProducts();
  const merc = useMercProducts();
  const q = useQuery({
    queryKey: ['delivery', id],
    queryFn: async () => {
      const cur = qc.getQueryData<Delivery>(['delivery', id]);
      // Pendant la lecture, chaque passage relève la réponse si elle est arrivée.
      const { data, error } = await supabase.rpc(cur?.scan_status === 'pending' ? 'delivery_scan_poll' : 'delivery_get', { p_id: id });
      if (error) throw error;
      return data as Delivery;
    },
    refetchInterval: (query) => ((query.state.data as Delivery | undefined)?.scan_status === 'pending' ? 2500 : false),
  });
  const d = q.data;
  const [lines, setLines] = useState<DeliveryLine[]>([]);
  const [meta, setMeta] = useState({ bl_number: '', bl_date: '', bl_total_ht: '' });
  const [dirty, setDirty] = useState(false);
  const [ok, setOk] = useState('oui');
  const [temp, setTemp] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [page, setPage] = useState<{ n: number; src: string } | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const stamp = d ? `${d.scan_status}|${d.lines.length}|${d.status}|${d.pages}` : '';

  // Ce que la base renvoie (lecture du bon, enregistrement) remplace la saisie tant qu'elle n'a pas été modifiée.
  useEffect(() => {
    if (!d || dirty) return;
    setLines(d.lines.map((l) => ({ ...l, quantity: l.quantity === null ? null : Number(l.quantity), unit_price: l.unit_price === null ? null : Number(l.unit_price), ordered: l.ordered === null ? null : Number(l.ordered) })));
    setMeta({ bl_number: d.bl_number, bl_date: d.bl_date ?? '', bl_total_ht: str(d.bl_total_ht) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const prodMap = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);
  if (q.isLoading) return <Loading />;
  if (q.error || !d) return <div className="list"><p className="empty err">{frError(q.error)}</p></div>;
  const draft = d.status === 'draft';
  const today = serviceDay();
  const total = linesTotal(lines);
  const blTotal = num(meta.bl_total_ht);
  const unmatched = lines.filter((l) => !l.skip && !l.product_id && !l.merc_key && (l.quantity ?? 0) > 0).length;
  const edit = (i: number, patch: Partial<DeliveryLine>) => { setDirty(true); setLines((a) => a.map((l, j) => (j === i ? { ...l, ...patch } : l))); };

  async function refresh() {
    setDirty(false);
    await qc.invalidateQueries({ queryKey: ['delivery', id] });
    await qc.invalidateQueries({ queryKey: ['deliveries'] });
  }

  async function scan() {
    setBusy('scan');
    setNotice('');
    const { data, error } = await supabase.rpc('delivery_scan', { p_id: id });
    setBusy('');
    if (error) return toast(frError(error), 'bad');
    const r = data as { status: string; message?: string };
    if (r.status !== 'pending') setNotice(r.message ?? 'Lecture impossible : saisis les lignes à la main.');
    await refresh();
  }

  async function addPhoto(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy('photo');
    try {
      const ph = await photoB64(f);
      const { error } = await supabase.rpc('delivery_add_photo', { p_id: id, p_mime: ph.mime, p_data: ph.data });
      if (error) throw error;
      setBusy('');
      // Une page de plus : le bon est relu en entier, si personne n'a encore corrigé les lignes.
      if (!dirty) await scan();
      else await refresh();
    } catch (x) {
      setBusy('');
      toast(frError(x), 'bad');
    }
  }

  async function showPage(n: number) {
    const { data } = await supabase.rpc('delivery_photo', { p_id: id, p_page: n });
    const p = data as { mime: string; data: string } | null;
    if (p) setPage({ n, src: `data:${p.mime};base64,${p.data}` });
  }

  async function removePage(n: number) {
    const { error } = await supabase.rpc('delivery_remove_photo', { p_id: id, p_page: n });
    if (error) return toast(frError(error), 'bad');
    setPage(null);
    await refresh();
  }

  const payload = () => lines.map((l) => ({
    label: l.label, product_id: l.product_id, merc_key: l.merc_key, quantity: l.quantity, unit: lineUnit(l), unit_price: l.unit_price,
    lot: l.lot, use_by: l.use_by, ordered: l.ordered, skip: l.skip, source: l.source,
  }));
  const metaPayload = () => ({ bl_number: meta.bl_number, bl_date: meta.bl_date, bl_total_ht: meta.bl_total_ht });

  async function save(silent = false) {
    if (lines.some((l) => l.quantity !== null && (Number.isNaN(l.quantity) || l.quantity < 0))) { setErr('Vérifie les quantités.'); return false; }
    const { error } = await supabase.rpc('delivery_save', { p_id: id, p_lines: payload(), p_meta: metaPayload() });
    if (error) { setErr(frError(error)); return false; }
    if (!silent) toast('Brouillon enregistré');
    await refresh();
    return true;
  }

  async function validate() {
    setErr('');
    const t = num(temp);
    if (t !== null && Number.isNaN(t)) return setErr('Vérifie la température.');
    setBusy('validate');
    if (!(await save(true))) return setBusy('');
    const { error } = await supabase.rpc('delivery_validate', { p_id: id, p_ok: ok === 'oui', p_temp: t, p_note: note });
    setBusy('');
    if (error) return setErr(frError(error));
    await qc.invalidateQueries({ queryKey: ['products'] });
    await qc.invalidateQueries({ queryKey: ['orders'] });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
    await refresh();
    toast('Livraison réceptionnée, stock mis à jour');
  }

  async function drop() {
    const { error } = await supabase.rpc('delivery_delete', { p_id: id });
    if (error) return toast(frError(error), 'bad');
    await qc.invalidateQueries({ queryKey: ['deliveries'] });
    toast('Réception abandonnée');
    onBack();
  }

  function pick(p: Picked) {
    setDirty(true);
    const patch = { product_id: p.product_id, merc_key: p.product_id ? null : p.merc_key, product_name: p.product_id ? p.name : null, merc_name: p.product_id ? null : p.name, product_unit: p.unit, merc_unit: p.unit };
    if (editing === 'new') setLines((a) => [...a, { label: '', quantity: null, unit: p.unit, unit_price: null, lot: '', use_by: null, ordered: null, skip: false, source: 'manual', ...patch }]);
    else if (typeof editing === 'number') edit(editing, { ...patch, skip: false });
    setEditing(null);
  }

  return (
    <div className="form delivery" data-status={d.status}>
      <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={onBack}>Toutes les livraisons</button>
      <p className="lead">{d.supplier_name || 'Livraison'}{d.order_id ? ' · commande de l\'appli' : ''}</p>
      {!draft && (
        <p className="note" data-done>
          {d.ok === false ? <span className="pill bad">Problème signalé</span> : <span className="pill ok">Réceptionnée</span>}{' '}
          par {d.received_by_name ?? "l'équipe"}{d.received_at ? `, ${fmtDayLong(d.received_at)} à ${fmtTime(d.received_at)}` : ''}{d.temp !== null ? ` · ${str(d.temp)} °C` : ''}.
          {d.note ? ` ${d.note}` : ''}
        </p>
      )}
      {!draft && d.issues.length > 0 && (
        <div className="list" data-testid="delivery-issues">
          {d.issues.map((i, k) => (
            <div className="row" key={k} data-issue={i.kind}>
              <span className="drive-ico"><Icon name="alert" size={18} /></span>
              <span className="grow"><span className="t">{i.product || 'Bon de livraison'}</span><span className="sub">{i.text}</span></span>
            </div>
          ))}
        </div>
      )}

      <Section title="1. Le bon de livraison">
        <div className="acts" style={{ alignItems: 'center' }}>
          {Array.from({ length: d.pages }, (_, k) => (
            <button type="button" className="btn sm" key={k} onClick={() => void showPage(k + 1)}><Icon name="doc" size={16} />Page {k + 1}</button>
          ))}
          {draft && (
            <label className="btn sm" style={{ position: 'relative' }}>
              {busy === 'photo' ? <Spinner /> : <><Icon name="cam" size={16} />{d.pages ? 'Ajouter une page' : 'Photographier le bon'}</>}
              <input id="bl-page" type="file" accept="image/*" capture="environment" disabled={!!busy} onChange={(e) => void addPhoto(e)}
                style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
            </label>
          )}
        </div>
        {d.scan_status === 'pending' && <p className="note" data-scan="pending"><Spinner /> Lecture du bon en cours… (de 10 à 40 secondes)</p>}
        {d.scan_status === 'error' && <p className="err" data-scan="error">{d.scan_error}</p>}
        {d.scan_status === 'done' && <p className="note" data-scan="done">Bon lu : vérifie chaque ligne avant de valider.{d.scan_note ? ` Remarque : ${d.scan_note}` : ''}</p>}
        {notice && <p className="note" data-scan="unavailable">{notice}</p>}
        {!notice && draft && d.pages > 0 && d.scan_status === 'none' && <p className="note">Le bon n'a pas encore été lu : touche « Lire le bon », ou ajoute les produits livrés à la main.</p>}
        {draft && d.pages > 0 && d.scan_status !== 'pending' && (
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void scan()}>
            {busy === 'scan' ? <Spinner /> : d.scan_status === 'none' ? 'Lire le bon' : 'Relire le bon'}
          </button>
        )}
        <div className="two">
          <Field label="N° du bon"><input className="in" id="bl-number" value={meta.bl_number} readOnly={!draft} onChange={(e) => { setDirty(true); setMeta((m) => ({ ...m, bl_number: e.target.value })); }} /></Field>
          <Field label="Date du bon"><input className="in" id="bl-date" type="date" value={meta.bl_date} readOnly={!draft} onChange={(e) => { setDirty(true); setMeta((m) => ({ ...m, bl_date: e.target.value })); }} /></Field>
        </div>
        <Field label="Total HT du bon" hint={`Total des lignes : ${euro(total)}`}>
          <input className="in num" id="bl-total" inputMode="decimal" value={meta.bl_total_ht} readOnly={!draft} onChange={(e) => { setDirty(true); setMeta((m) => ({ ...m, bl_total_ht: e.target.value })); }} />
        </Field>
        {blTotal !== null && !Number.isNaN(blTotal) && total > 0 && Math.abs(blTotal - total) > 1 && <p className="note" data-total-gap><span className="pill warn">Total</span> Le total du bon ne correspond pas aux lignes : une ligne manque ou une quantité est fausse.</p>}
      </Section>

      <Section title={`2. Ce qui est livré (${lines.length})`}>
        <div className="list" data-testid="delivery-lines">
          {lines.length === 0 && <p className="empty">{d.pages ? 'Aucune ligne pour l\'instant.' : 'Photographie le bon, ou ajoute les produits livrés.'}</p>}
          {lines.map((l, i) => {
            const name = lineName(l);
            const p = l.product_id ? prodMap.get(l.product_id) : undefined;
            const flags = lineFlags(l, today, p?.unit_price || null, !!d.order_id);
            return (
              <div className="row wrap" key={i} data-line={name || l.label}>
                <div className="grow">
                  <span className="t">{name || <span style={{ color: 'var(--bad)' }}>Produit à choisir</span>}</span>
                  <span className="sub">{[l.label && name && l.label.toLowerCase() !== name.toLowerCase() ? `Sur le bon : ${l.label}` : !name ? l.label : '',
                    l.unit_price !== null ? `${euro(l.unit_price)} HT` : '', l.lot ? `lot ${l.lot}` : '', l.merc_key && !l.product_id ? 'sera suivi en stock' : ''].filter(Boolean).join(' · ')}</span>
                  {flags.length > 0 && <span className="sub" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>{flags.map((f) => <span key={f.text} className={`pill ${f.tone}`}>{f.text}</span>)}</span>}
                </div>
                <div className="end">
                  <input className="in qty num" inputMode="decimal" aria-label={`Quantité reçue de ${name || l.label}`} value={l.quantity === null ? '' : str(l.quantity)} readOnly={!draft}
                    onChange={(e) => edit(i, { quantity: num(e.target.value) })} placeholder={l.ordered !== null ? fmtQty(l.ordered) : '0'} />
                  <span className="sub" style={{ minWidth: 34 }}>{lineUnit(l)}</span>
                  {draft && <button type="button" className="btn sm" aria-label={`Modifier la ligne ${name || l.label}`} onClick={() => setEditing(i)}><Icon name="cog" size={16} /></button>}
                </div>
              </div>
            );
          })}
        </div>
        {draft && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing('new')}><Icon name="plus" size={16} />Ajouter un produit</button>}
        {unmatched > 0 && <p className="note"><span className="pill bad">{unmatched}</span> ligne{unmatched > 1 ? 's' : ''} sans produit : touche la roue pour choisir le produit de la mercuriale, ou marque « pas suivi en stock » (transport, consigne…).</p>}
      </Section>

      {draft && (
        <Section title="3. Le contrôle">
          <div className="two">
            <Field label="Marchandise conforme ?">
              <select className="in" id="rec-ok" value={ok} onChange={(e) => setOk(e.target.value)}>
                <option value="oui">Oui</option>
                <option value="non">Non, il y a un problème</option>
              </select>
            </Field>
            <Field label="Température (°C)" hint="Produits frais ou surgelés.">
              <input className="in" id="rec-temp" inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} />
            </Field>
          </div>
          <Field label="Note" hint="Manquant, casse, produit refusé…">
            <input className="in" id="rec-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </Field>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="acts">
            <button type="button" className="btn" disabled={!!busy} onClick={() => void save()}>Enregistrer</button>
            <button type="button" className="btn pri" disabled={!!busy || d.scan_status === 'pending'} onClick={() => void validate()}>{busy === 'validate' ? <Spinner /> : 'Valider la réception'}</button>
          </div>
          <p className="note">À la validation, le stock de chaque produit augmente de la quantité reçue, la commande est close et le gérant est prévenu des écarts.</p>
          {confirmDrop ? (
            <div className="acts">
              <button type="button" className="btn" onClick={() => setConfirmDrop(false)}>Garder</button>
              <button type="button" className="btn no" onClick={() => void drop()}>Abandonner cette réception</button>
            </div>
          ) : <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirmDrop(true)}>Abandonner (commencée par erreur)</button>}
        </Section>
      )}

      {editing !== null && (editing === 'new' || lines[editing]) && (
        editing === 'new'
          ? <ProductPicker title="Ajouter un produit livré" products={products.data ?? []} merc={merc.data ?? []} onPick={pick} onClose={() => setEditing(null)} />
          : <LineSheet line={lines[editing]} products={products.data ?? []} merc={merc.data ?? []}
              onChange={(patch) => edit(editing, patch)} onPick={pick}
              onRemove={() => { setDirty(true); setLines((a) => a.filter((_, j) => j !== editing)); setEditing(null); }} onClose={() => setEditing(null)} />
      )}
      {page && (
        <Sheet title={`Bon de livraison · page ${page.n}`} onClose={() => setPage(null)}>
          <img className="poster" src={page.src} alt={`Bon de livraison, page ${page.n}`} />
          {draft && <button type="button" className="btn no block" onClick={() => void removePage(page.n)}>Retirer cette page</button>}
        </Sheet>
      )}
    </div>
  );
}

/* ---------- Une ligne : produit, prix, lot, date limite ---------- */
function LineSheet({ line, products, merc, onChange, onPick, onRemove, onClose }: {
  line: DeliveryLine; products: Product[]; merc: MercProduct[];
  onChange: (patch: Partial<DeliveryLine>) => void; onPick: (p: Picked) => void; onRemove: () => void; onClose: () => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const name = lineName(line);
  if (choosing) return <ProductPicker title="Quel produit ?" products={products} merc={merc} onPick={(p) => { setChoosing(false); onPick(p); }} onClose={() => setChoosing(false)} />;
  return (
    <Sheet title={name || line.label || 'Ligne du bon'} onClose={onClose}>
      <div className="form">
        {line.label && <p className="note">Sur le bon : « {line.label} »</p>}
        <button type="button" className="btn block" id="line-product" onClick={() => setChoosing(true)}>{name ? `Produit : ${name} (changer)` : 'Choisir le produit dans la mercuriale'}</button>
        <div className="two">
          <Field label={`Prix unitaire HT${lineUnit(line) ? ` (par ${lineUnit(line)})` : ''}`}>
            <input className="in num" id="line-price" inputMode="decimal" value={str(line.unit_price)} onChange={(e) => onChange({ unit_price: num(e.target.value) })} />
          </Field>
          <Field label="Lot"><input className="in" id="line-lot" value={line.lot} onChange={(e) => onChange({ lot: e.target.value })} maxLength={60} /></Field>
        </div>
        <Field label="Date limite (DLC ou DDM)">
          <input className="in" id="line-use-by" type="date" value={line.use_by ?? ''} onChange={(e) => onChange({ use_by: e.target.value || null })} />
        </Field>
        <label className="row" style={{ padding: 0, gap: 10 }}>
          <input id="line-skip" type="checkbox" checked={line.skip} onChange={(e) => onChange({ skip: e.target.checked })} style={{ width: 22, height: 22, flex: 'none' }} />
          <span className="grow"><span className="t">Pas suivi en stock</span><span className="sub">Transport, consigne, remise : la ligne reste sur le bon, sans toucher au stock.</span></span>
        </label>
        <button type="button" className="btn pri block" onClick={onClose}>OK</button>
        <button type="button" className="btn no block" onClick={onRemove}>Retirer cette ligne</button>
      </div>
    </Sheet>
  );
}
