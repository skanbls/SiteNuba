import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Chips, Loading } from '../components/ui';
import { cap } from '../lib/carte';
import { useDeliverySettings, useMercOrders, useMercRecipes } from '../lib/data';
import { EMPTY_DELIVERY, blNumber, deliveryLines, dlcOf, fmtDayFr, fmtTemp, lotOf, type Scope } from '../lib/delivery';
import { Book } from '../lib/production';
import { useSession } from '../lib/session';
import { frError } from '../lib/supabase';
import { fmtDayLong, fromDayKey } from '../lib/time';

const SCOPES: [Scope, string][] = [['tout', 'Les deux'], ['saveurs_nomades', 'Saveurs Nomades'], ['comptoir', 'Comptoir']];
const BLANK = '________';
const longDay = (d: string) => cap(fmtDayLong(fromDayKey(d)));

/**
 * Bon de livraison d'un jour, prêt à imprimer en A4 : il se fabrique tout seul à partir des
 * commandes des mercuriales (onglet PRESTATIONS). Avant d'imprimer, on peut noter la température
 * au départ et corriger une quantité livrée ; rien n'est enregistré, la feuille signée fait foi.
 */
export default function DeliveryNote() {
  const { day = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const m = params.get('m');
  const scope: Scope = m === 'saveurs_nomades' || m === 'comptoir' ? m : 'tout';
  const { profile } = useSession();
  const boss = profile?.role === 'gerant';
  const orders = useMercOrders();
  const recipes = useMercRecipes();
  const settings = useDeliverySettings();
  const book = useMemo(() => new Book(recipes.data ?? [], []), [recipes.data]);
  const s = settings.data ?? EMPTY_DELIVERY;
  const [temp, setTemp] = useState('');
  const [delivered, setDelivered] = useState<Record<number, string>>({});
  useEffect(() => setDelivered({}), [day, scope]);

  const lines = deliveryLines(orders.data ?? [], book, day, scope);
  const days = Array.from(new Set((orders.data ?? []).filter((o) => scope === 'tout' || o.brand === scope).map((o) => o.day))).sort();
  if (day && !days.includes(day)) days.push(day);
  const number = blNumber(day, scope);
  const t = fmtTemp(temp);
  const out = (id: number, qty: number) => {
    const v = (delivered[id] ?? '').replace(',', '.').trim();
    const n = v === '' ? qty : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : qty;
  };
  const totalCmd = lines.reduce((x, l) => x + l.qty, 0);
  const totalOut = lines.reduce((x, l) => x + out(l.id, l.qty), 0);
  const missing = lines.filter((l) => l.missing.length);
  const headerEmpty = !s.sender_name || !s.client_name;
  const sender = s.sender_name || "l'expéditeur";
  const client = s.client_name || 'le client';

  function print() {
    // Le nom du PDF enregistré depuis la fenêtre d'impression : le numéro du bon.
    const before = document.title;
    document.title = number;
    window.print();
    setTimeout(() => { document.title = before; }, 1000);
  }

  if (orders.isLoading || recipes.isLoading || settings.isLoading) return <div className="bl-page"><Loading /></div>;
  const error = orders.error ?? recipes.error;
  return (
    <div className="bl-page">
      <div className="bl-bar no-print">
        <Link className="btn sm" to="/production"><Icon name="back" size={16} />Production</Link>
        <select className="in" id="bl-day" aria-label="Jour de livraison" value={day} onChange={(e) => navigate({ pathname: `/bl/${e.target.value}`, search: params.toString() })} style={{ flex: '2 1 220px' }}>
          {days.map((d) => (<option key={d} value={d}>{longDay(d)}</option>))}
        </select>
        <Chips value={scope} options={SCOPES} onChange={(v) => setParams(v === 'tout' ? {} : { m: v }, { replace: true })} label="Marque" />
        <label className="bl-temp">
          <span>Température au départ</span>
          <input className="in" id="bl-temp" inputMode="decimal" placeholder="°C" value={temp} onChange={(e) => setTemp(e.target.value)} />
        </label>
        <button type="button" className="btn pri" onClick={print}><Icon name="doc" size={16} />Imprimer</button>
      </div>
      {error && <p className="err no-print">{frError(error)}</p>}
      {settings.error && <p className="err no-print">{frError(settings.error)}</p>}
      {headerEmpty && !settings.error && (
        <p className="note no-print bl-note">
          L'en-tête du bon (ta société, le client, le lieu de livraison) est à remplir une fois{' '}
          {boss ? <>dans <Link className="link" to="/reglages">Administration</Link>, rubrique « Bons de livraison »</> : 'par le gérant, dans Administration'}.
        </p>
      )}
      {missing.length > 0 && (
        <p className="err no-print bl-note">
          Allergènes incomplets : pas de fiche pour {missing.flatMap((l) => l.missing).map((n) => `« ${n} »`).join(', ')}. Complète la mercuriale avant d'imprimer.
        </p>
      )}
      <p className="note no-print bl-note">Les quantités livrées se corrigent dans le tableau avant d'imprimer. Rien n'est enregistré : le bon signé fait foi.</p>

      <article className="bl" data-bl={number}>
        <header className="bl-head">
          <div>
            <div className="bl-sender">{s.sender_name || BLANK}</div>
            {s.sender_tagline && <div className="bl-tag">{s.sender_tagline}</div>}
            {s.sender_address && <div>Siège social : {s.sender_address}</div>}
            <div>{[s.sender_siret && `SIRET : ${s.sender_siret}`, s.sender_contact && `Contact exploitation : ${s.sender_contact}`].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="bl-title">
            <h1>Bon de livraison</h1>
            <div>N° de BL : <b>{number}</b></div>
            <div>Date de livraison : <b>{day ? `${cap(fmtDayLong(fromDayKey(day)).split(' ')[0])} ${fmtDayFr(day)}` : ''}</b></div>
            {s.slot && <div>Créneau de livraison : <b>{s.slot}</b></div>}
          </div>
        </header>

        <div className="bl-boxes">
          <section>
            <h2>Client et facturation</h2>
            <p className="bl-strong">{s.client_name || BLANK}</p>
            {s.client_address && <p>Adresse de facturation : {s.client_address}</p>}
            {s.client_siret && <p>SIRET client : {s.client_siret}</p>}
          </section>
          <section>
            <h2>Lieu et modalités de livraison</h2>
            <p className="bl-strong">{s.place_name || BLANK}</p>
            {s.place_address && <p>Adresse : {s.place_address}</p>}
            {s.place_access && <p>Instructions d'accès : {s.place_access}</p>}
          </section>
        </div>

        <div className="bl-scroll">
        <table className="bl-table">
          <thead>
            <tr>
              <th>Marque</th><th>Désignation des produits et conditionnement</th><th>Lot</th><th>DLC</th>
              <th>T° départ</th><th>T° arrivée</th><th className="n">Qté cmd</th><th className="n">Qté livrée</th><th className="n">Qté reçue</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={9} className="bl-empty">Aucune commande à cette date.</td></tr>}
            {lines.map((l) => (
              <tr key={l.id} data-bl-line={l.name}>
                <td>{l.brandLabel}</td>
                <td>
                  <b>{l.name}</b>
                  <div>{l.detail}</div>
                  {l.allergens.length > 0 && <div>Allergènes : {l.allergens.join(', ')}</div>}
                </td>
                <td className="nw">{lotOf(day, s.lot_days_before)}</td>
                <td className="nw">{dlcOf(day, s.dlc_days)}</td>
                <td className="nw">{t || '____ °C'}</td>
                <td className="nw">____ °C</td>
                <td className="n">{l.qty}</td>
                <td className="n">
                  <input className="bl-qty" inputMode="numeric" aria-label={`Quantité livrée, ${l.name}`} value={delivered[l.id] ?? String(l.qty)}
                    onChange={(e) => setDelivered((d) => ({ ...d, [l.id]: e.target.value }))} />
                </td>
                <td className="n">______</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th colSpan={6}>Total des repas livrés</th><th className="n">{totalCmd}</th><th className="n" data-testid="bl-total">{totalOut}</th><th className="n">______</th></tr>
          </tfoot>
        </table>
        </div>

        <section className="bl-box">
          <h2>Contrôle sanitaire à réception (protocole HACCP)</h2>
          <p>
            Liaison : <span className="bl-check" /> Froide (0 °C à +3 °C) <span className="bl-check" /> Chaude (≥ +63 °C)
            <span className="bl-gap" />Intégrité et étiquetage : <span className="bl-check" /> Conforme <span className="bl-check" /> Non conforme
          </p>
        </section>
        <p className="bl-legal">
          Mentions réglementaires : la marchandise voyage aux risques et périls définis au contrat. À la réception, {s.client_name ? `le client ${s.client_name}` : 'le client'} s'engage
          à vérifier le nombre exact de plats, l'état des emballages ainsi que la température à cœur ou entre paquets. Conformément à l'article L.133-3
          du Code de commerce, toute réserve (manquant, avarie, rupture de la chaîne du froid) doit être impérativement annotée de manière précise et
          motivée ci-dessous en présence du livreur. Aucune réclamation relative à l'état apparent ou à la température ne pourra être acceptée après le
          départ du transporteur.
        </p>

        <div className="bl-boxes bl-sign">
          <section>
            <h2>Pour {sender} (expéditeur, livreur)</h2>
            <p>Nom du livreur : {s.driver || BLANK}</p>
            <p>Date de départ : {fmtDayFr(day)}{s.slot ? ` à ${s.slot}` : ' à ____ h ____'}</p>
            <p>Température au départ : {t || `${BLANK} °C`}</p>
            <p>Total livré : {totalOut} plats</p>
            <p>Signature du livreur :</p>
          </section>
          <section>
            <h2>Pour {client} (client réceptionnaire)</h2>
            <p>Nom et qualité : ______________________</p>
            <p>Reçu le : {fmtDayFr(day)} à ____ h ____</p>
            <p>Réserves éventuelles : ________________</p>
            <p>______________________________________</p>
            <p>Signature et cachet{s.client_name ? ` de ${s.client_name}` : ''} :</p>
          </section>
        </div>
        <footer className="bl-foot">
          Bon de livraison — {[s.sender_name, s.client_name].filter(Boolean).join(' / ') || number} — Livraison du {fmtDayFr(day)} — Exemplaire à conserver (traçabilité sanitaire)
        </footer>
      </article>
    </div>
  );
}
