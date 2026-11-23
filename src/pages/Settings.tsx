import { useCallback, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon';
import { RightsPicker } from '../components/Rights';
import { Avatar, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useQuery } from '@tanstack/react-query';
import { buildAppsScript, sheetId } from '../lib/appsScript';
import { useAccountants, useAccountingSettings, useAllRights, useDashboard, useDeliverySettings, useEmailLog, useEmailSettings, useKiosks, useMercSources, useRefresh, useSites, useTeam } from '../lib/data';
import { EMPTY_DELIVERY, type DeliverySettings } from '../lib/delivery';
import type { MercSource } from '../lib/production';
import { AREAS, type Area } from '../lib/rights';
import { appUrl, frError, key as publicKey, supabase, url as projectUrl } from '../lib/supabase';
import { fmtDay, fmtTime } from '../lib/time';
import { fullName, type AccountantAccess, type EmailLogEntry, type EmailSettings, type Profile, type Site } from '../lib/types';

const ADMIN_LINKS: [string, IconName, string, string][] = [
  ['/equipe', 'team', 'Équipe', 'Fiches, rôles, codes PIN, accès et dossiers Drive'],
  ['/checklists', 'check', 'Checklists', 'Nouvelle liste, ou « Modifier cette liste »'],
  ['/hygiene', 'thermo', 'Hygiène', 'Enceintes froides, plan de nettoyage'],
  ['/stocks', 'box', 'Stocks', 'Produits, seuils d\'alerte, quantités voulues, prix'],
  ['/commandes', 'truck', 'Fournisseurs', 'Coordonnées, jours de livraison, minimum de commande'],
  ['/fiches', 'list', 'Fiches techniques', 'La carte Nuba (mercuriale Nuba) : coûts, marges, allergènes'],
  ['/production', 'pot', 'Production', 'Fiches et commandes des mercuriales : elles se modifient dans Google Sheets'],
  ['/procedures', 'doc', 'Procédures', 'Consignes de l\'équipe, lecture à confirmer'],
  ['/planning', 'cal', 'Planning', 'Services de la semaine, congés'],
  ['/reservations', 'book', 'Réservations', 'Horaires, créneaux, lien et code pour le site'],
  ['/maintenance', 'tool', 'Échéances', 'Contrôles, contrats, documents de l\'équipe'],
];

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;
const MERC_ORDER = ['nuba', 'saveurs_nomades', 'comptoir'];

const MAIL_STATUS: Record<EmailLogEntry['status'], [string, string]> = {
  queued: ['', 'En attente'],
  sent: ['info', 'Parti'],
  accepted: ['ok', 'Accepté par Brevo'],
  failed: ['bad', 'Échec'],
};

/** Administration : ce que le gérant règle, et ce qu'il confie aux responsables. */
export default function Settings() {
  const toast = useToast();
  const refresh = useRefresh();
  const sites = useSites();
  const kiosks = useKiosks();
  const team = useTeam();
  const rights = useAllRights(true);
  const mail = useEmailSettings();
  const log = useEmailLog();
  const merc = useMercSources();
  const mercStatus = useQuery({
    queryKey: ['merc', 'status'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('merc_status');
      if (error) throw error;
      return data as { key_created_at: string | null; log: { at: string; brand: string; ok: boolean; message: string }[] };
    },
  });
  const [mercSheet, setMercSheet] = useState(false);
  const delivery = useDeliverySettings();
  const accounting = useAccountingSettings(true);
  const [zeltySheet, setZeltySheet] = useState(false);
  const dashboard = useDashboard(true);
  const [blSheet, setBlSheet] = useState(false);
  const closeBl = useCallback(() => setBlSheet(false), []);
  const accountants = useAccountants(true);
  const [accSheet, setAccSheet] = useState<AccountantAccess | 'new' | null>(null);
  const closeAcc = useCallback(() => setAccSheet(null), []);
  const closeMerc = useCallback(() => setMercSheet(false), []);
  const [addSite, setAddSite] = useState(false);
  const [addKiosk, setAddKiosk] = useState(false);
  const [pair, setPair] = useState<{ label: string; code: string } | null>(null);
  const [rightsFor, setRightsFor] = useState<Profile | null>(null);
  const [mailSheet, setMailSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const closeSite = useCallback(() => setAddSite(false), []);
  const closeKiosk = useCallback(() => setAddKiosk(false), []);
  const closePair = useCallback(() => setPair(null), []);
  const closeRights = useCallback(() => setRightsFor(null), []);
  const closeMail = useCallback(() => setMailSheet(false), []);
  const live = (kiosks.data ?? []).filter((k) => !k.revoked_at);
  const leads = (team.data ?? []).filter((p) => p.active && p.role === 'responsable');
  const areasOf = (id: string) => (rights.data ?? []).filter((r) => r.profile_id === id).map((r) => r.area as Area);

  async function toggleSite(s: Site) {
    const { error } = await supabase.from('sites').update({ active: !s.active }).eq('id', s.id);
    if (error) return toast(frError(error), 'bad');
    await refresh('sites');
    toast(s.active ? 'Lieu désactivé' : 'Lieu réactivé');
  }

  async function revoke(id: string) {
    const { error } = await supabase.from('kiosks').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    if (error) return toast(frError(error), 'bad');
    await refresh('kiosks');
    toast('Borne désactivée');
  }

  async function relink(id: string, label: string) {
    setBusy(true);
    const { data, error } = await supabase.rpc('start_kiosk_pairing', { p_kiosk: id });
    setBusy(false);
    if (error) return toast(frError(error), 'bad');
    setPair({ label, code: data as string });
  }

  async function testMail() {
    setBusy(true);
    const { data, error } = await supabase.rpc('send_test_email');
    setBusy(false);
    await refresh('emails');
    if (error) return toast(frError(error), 'bad');
    const r = data as { ok: boolean; to: string; error: string };
    toast(r.ok ? `Essai envoyé à ${r.to}. Regarde ta boîte dans une minute.` : r.error || "L'essai n'est pas parti.", r.ok ? 'ok' : 'bad');
  }

  async function copy(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast(text);
    }
  }

  const bookingLink = `${appUrl()}#/reserver`;
  const eventLink = `${appUrl()}#/privatiser`;

  return (
    <Layout title="Administration">
      <div className="cols">
        <div className="stack">
          <Section title="Accès des responsables">
            {team.isLoading || rights.isLoading ? <Loading /> : rights.error ? <div className="list"><p className="empty err">{frError(rights.error)}</p></div> : (
              <div className="list">
                {leads.length === 0 && <p className="empty">Aucun responsable. Dans Équipe, donne le rôle « Responsable » à une personne pour lui confier une partie de l'appli.</p>}
                {leads.map((p) => {
                  const a = areasOf(p.id);
                  return (
                    <button type="button" className="row" key={p.id} onClick={() => setRightsFor(p)} data-lead={fullName(p)}>
                      <Avatar p={p} />
                      <div className="grow">
                        <span className="t">{fullName(p)}</span>
                        <span className="sub">{a.length ? AREAS.filter(([x]) => a.includes(x)).map(([, l]) => l).join(', ') : 'Ne modifie rien pour l\'instant'}</span>
                      </div>
                      <span className="chev"><Icon name="chev" size={18} /></span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="note">Un responsable modifie ce que tu lui confies, avec son compte. L'équipe, les accès, les bornes et les e-mails restent à toi.</p>
          </Section>

          <Section title="Où modifier quoi">
            <div className="list">
              {ADMIN_LINKS.map(([to, icon, label, hint]) => (
                <Link className="row" to={to} key={to}>
                  <Icon name={icon} />
                  <div className="grow"><span className="t">{label}</span><span className="sub">{hint}</span></div>
                  <span className="chev"><Icon name="chev" size={18} /></span>
                </Link>
              ))}
            </div>
          </Section>

          <Section title="Accès comptable" right={<button type="button" className="link" onClick={() => setAccSheet('new')}>Ajouter</button>}>
            {accountants.isLoading ? <Loading /> : accountants.error ? <div className="list"><p className="empty err">{frError(accountants.error)}</p></div> : (
              <div className="list">
                {(accountants.data ?? []).length === 0 && <p className="empty">Aucun accès. Ajoute l'adresse e-mail de la comptable : elle verra le récap du mois, les documents de l'équipe et la caisse.</p>}
                {(accountants.data ?? []).map((a) => (
                  <button type="button" className="row" key={a.id} onClick={() => setAccSheet(a)} data-accountant={a.email}>
                    <div className="grow">
                      <span className="t">{a.name || a.email}</span>
                      <span className="sub">{[a.name ? a.email : null, a.last_seen_at ? `vue ${fmtDay(a.last_seen_at)} à ${fmtTime(a.last_seen_at)}` : null].filter(Boolean).join(' · ')}</span>
                    </div>
                    <span className="end">
                      {!a.active ? <span className="pill">Désactivé</span> : a.user_id ? <span className="pill ok">Compte créé</span> : <span className="pill warn">En attente d'inscription</span>}
                      <span className="chev"><Icon name="chev" size={18} /></span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="list">
              <div className="row wrap" data-testid="zelty-lien">
                <div className="grow">
                  <span className="t">Caisse Zelty</span>
                  <span className="sub">{accounting.data?.zelty_url ? accounting.data.zelty_url : 'Lien du tableau de bord Zelty, pour la comptable (Z de caisse, encaissements)'}</span>
                </div>
                <div className="end"><button type="button" className="btn sm" onClick={() => setZeltySheet(true)}>{accounting.data?.zelty_url ? 'Changer le lien' : 'Ajouter le lien'}</button></div>
              </div>
            </div>
            <p className="note">Elle ouvre le lien de l'appli et crée son compte avec cette adresse (« Créer mon compte »). Elle voit le récap du mois (heures, pauses déduites, absences par motif) et le télécharge pour la paie, les documents de l'équipe (arrêts, pièces d'identité, DPAE…) et la caisse. Elle reçoit un e-mail à chaque document envoyé. Rien d'autre : ni planning, ni réservations, ni coordonnées.</p>
            <Link className="btn" to="/heures"><Icon name="user" />Voir ce que voit la comptable</Link>
          </Section>

          <Section title="Site web et liens publics">
            <div className="list">
              <div className="row wrap">
                <div className="grow"><span className="t">Réserver une table</span><span className="sub">Jusqu'à 9 personnes, sur les créneaux d'ouverture</span></div>
                <div className="end"><button type="button" className="btn sm" onClick={() => void copy(bookingLink, 'Lien de réservation copié')}><Icon name="copy" size={16} />Copier</button></div>
              </div>
              <div className="row wrap">
                <div className="grow"><span className="t">Demander une privatisation</span><span className="sub">Groupes, soirées privées, prestations extérieures</span></div>
                <div className="end"><button type="button" className="btn sm" onClick={() => void copy(eventLink, 'Lien de privatisation copié')}><Icon name="copy" size={16} />Copier</button></div>
              </div>
            </div>
            <p className="note">Le formulaire du site de la Nuba enregistre ses réservations directement ici. Ces liens servent aussi pour Instagram ou la fiche Google.</p>
          </Section>
        </div>

        <div className="stack">
          <Section title="E-mails" right={<button type="button" className="link" onClick={() => setMailSheet(true)}>Régler</button>}>
            {mail.isLoading ? <Loading /> : mail.error ? <div className="list"><p className="empty err">{frError(mail.error)}</p></div> : (
              <div className="list">
                <div className="row wrap">
                  <div className="grow">
                    <span className="t">{mail.data?.enabled ? 'Envoi activé' : 'Envoi coupé'}</span>
                    <span className="sub">{mail.data?.enabled ? `De ${mail.data.sender_name} <${mail.data.sender_email}>` : 'Aucun e-mail ne part. Touche « Régler » pour la mise en route.'}</span>
                  </div>
                  <div className="end">
                    <span className={`pill ${mail.data?.enabled ? 'ok' : ''}`}>{mail.data?.enabled ? 'Activé' : 'Coupé'}</span>
                    {mail.data?.enabled && <button type="button" className="btn sm" disabled={busy} onClick={() => void testMail()}>Envoyer un essai</button>}
                  </div>
                </div>
                {(log.data ?? []).slice(0, 6).map((m) => (
                  <div className="row wrap" key={m.id}>
                    <div className="grow">
                      <span className="t">{m.subject}</span>
                      <span className="sub">À {m.to} · {fmtDay(m.at)} à {fmtTime(m.at)}</span>
                      {m.error && <span className="sub err">{m.error}</span>}
                    </div>
                    <div className="end"><span className={`pill ${MAIL_STATUS[m.status][0]}`}>{MAIL_STATUS[m.status][1]}</span></div>
                  </div>
                ))}
              </div>
            )}
            <p className="note">Confirmation au client à chaque réservation en ligne, et alerte pour toi à chaque réservation ou demande de privatisation.</p>
          </Section>

          <Section title="Mercuriales Google Sheets" right={<button type="button" className="link" onClick={() => setMercSheet(true)}>{mercStatus.data?.key_created_at ? 'Nouveau script' : 'Relier'}</button>}>
            {merc.isLoading ? <Loading /> : merc.error ? <div className="list"><p className="empty err">{frError(merc.error)}</p></div> : (
              <div className="list">
                {[...(merc.data ?? [])].sort((a, b) => MERC_ORDER.indexOf(a.brand) - MERC_ORDER.indexOf(b.brand)).map((m) => {
                  // Dernier envoi de cette mercuriale : s'il a été refusé, on dit pourquoi.
                  const last = (mercStatus.data?.log ?? []).find((l) => l.brand === m.brand);
                  const skipped = last && last.ok && /ignorées/.test(last.message) ? last : null;
                  return (
                    <div className="row wrap" key={m.brand} data-merc={m.brand}>
                      <div className="grow">
                        <span className="t">{m.label}</span>
                        <span className="sub">{!m.synced_at ? 'Jamais reçue' : `Reçue ${fmtDay(m.synced_at)} à ${fmtTime(m.synced_at)} · ${m.brand === 'nuba'
                          ? `${plural(m.counts.plats ?? 0, 'plat')}, ${plural(m.counts.boissons ?? 0, 'boisson')}, ${plural(m.counts.preparations ?? 0, 'préparation')} maison${m.counts.todo ? ` · ${plural(m.counts.todo, 'fiche')} à compléter` : ''}`
                          : `${plural(m.counts.recipes ?? 0, 'fiche')}, ${plural(m.counts.orders ?? 0, 'commande')}`}`}</span>
                        <SyncProblem brand={m.brand} linked={!!m.sheet_url} syncedAt={m.synced_at} log={mercStatus.data?.log ?? []} keyAt={mercStatus.data?.key_created_at ?? null} />
                        {skipped && <span className="sub" style={{ color: 'var(--warn)' }}>Attention : {skipped.message.replace(/^.*\((.*)\)$/, '$1')}. Vérifie leur date, leur plat et leurs portions dans PRESTATIONS.</span>}
                      </div>
                      {m.sheet_url && <div className="end"><a className="btn sm" href={m.sheet_url} target="_blank" rel="noopener noreferrer">Ouvrir</a></div>}
                    </div>
                  );
                })}
              </div>
            )}
            {!dashboard.error && (() => {
              const d = dashboard.data;
              return (
                <div className="list">
                  <div className="row wrap" data-merc="tableau">
                    <div className="grow">
                      <span className="t">Tableau de bord financier</span>
                      <span className="sub">{d?.synced_at ? `Reçu ${fmtDay(d.synced_at)} à ${fmtTime(d.synced_at)} · gérants seulement` : 'Jamais reçu · gérants seulement'}</span>
                      <SyncProblem brand="tableau" linked={!!d?.sheet_url} syncedAt={d?.synced_at ?? null} log={mercStatus.data?.log ?? []} keyAt={mercStatus.data?.key_created_at ?? null} />
                    </div>
                    <div className="end">
                      {d?.synced_at && <Link className="btn sm" to="/tableau-de-bord">Voir</Link>}
                      {d?.sheet_url && <a className="btn sm" href={d.sheet_url} target="_blank" rel="noopener noreferrer">Ouvrir</a>}
                    </div>
                  </div>
                </div>
              );
            })()}
            <p className="note">Un petit script Google, installé une fois, envoie les mercuriales toutes les dix minutes : la carte Nuba dans Fiches techniques, Saveurs Nomades et Comptoir dans Production, et le tableau de bord financier (gérants seulement).</p>
            {mercStatus.data?.key_created_at && (
              <p className="note" data-testid="merc-key">
                Script actuel créé {fmtDay(mercStatus.data.key_created_at)} à {fmtTime(mercStatus.data.key_created_at)} : c'est celui-là qui doit être collé dans Google. Chaque « Créer le script » en fait un nouveau et arrête le précédent.
              </p>
            )}
          </Section>

          <Section title="Bons de livraison" right={<button type="button" className="link" onClick={() => setBlSheet(true)}>Modifier l'en-tête</button>}>
            {delivery.isLoading ? <Loading /> : delivery.error ? <div className="list"><p className="empty err">{frError(delivery.error)}</p></div> : (
              <div className="list">
                <div className="row wrap" data-testid="bl-reglages">
                  <div className="grow">
                    {delivery.data?.sender_name && delivery.data.client_name ? (
                      <>
                        <span className="t">{delivery.data.sender_name} → {delivery.data.client_name}</span>
                        <span className="sub">{[delivery.data.place_name, delivery.data.slot && `créneau ${delivery.data.slot}`, `DLC J+${delivery.data.dlc_days}`, delivery.data.driver && `livreur ${delivery.data.driver}`].filter(Boolean).join(' · ')}</span>
                      </>
                    ) : (
                      <>
                        <span className="t">En-tête à remplir</span>
                        <span className="sub">Ta société, le client et le lieu de livraison, une seule fois.</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
            <p className="note">Les bons de livraison Saveurs Nomades et Comptoir se fabriquent tout seuls à partir des commandes des mercuriales : Production, « Bon de livraison » sous chaque jour.</p>
          </Section>

          <Section title="Bornes de pointage" right={<button type="button" className="link" onClick={() => setAddKiosk(true)}>Ajouter une borne</button>}>
            {kiosks.isLoading ? <Loading /> : (
              <div className="list">
                {live.length === 0 && <p className="empty">Aucune borne. Ajoute-en une, puis relie-la à l'iPad qui restera à la Nuba.</p>}
                {live.map((k) => (
                  <div className="row wrap" key={k.id}>
                    <div className="grow">
                      <span className="t">{k.label}</span>
                      <span className="sub">{k.sites?.name} · {k.last_seen_at ? `vue ${fmtDay(k.last_seen_at)} à ${fmtTime(k.last_seen_at)}` : 'aucun appareil relié pour l\'instant'}</span>
                    </div>
                    <div className="end">
                      <button type="button" className="btn sm" disabled={busy} onClick={() => void relink(k.id, k.label)}>Relier un appareil</button>
                      <button type="button" className="btn sm no" onClick={() => void revoke(k.id)}>Désactiver</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="note">Une borne est un appareil qui affiche le QR code de pointage : en général un iPad fixe. Pour changer d'appareil, touche « Relier un appareil » : le nouveau remplace l'ancien.</p>
          </Section>

          <Section title="Lieux de pointage" right={<button type="button" className="link" onClick={() => setAddSite(true)}>Ajouter un lieu</button>}>
            {sites.isLoading ? <Loading /> : (
              <div className="list">
                {(sites.data ?? []).map((s) => (
                  <div className="row wrap" key={s.id}>
                    <div className="grow">
                      <span className="t">{s.name}</span>
                      <span className="sub">{s.kind === 'evenement' ? 'Prestation extérieure' : 'Établissement'}</span>
                    </div>
                    <div className="end">
                      {!s.active && <span className="pill">Désactivé</span>}
                      <button type="button" className="btn sm" onClick={() => void toggleSite(s)}>{s.active ? 'Désactiver' : 'Réactiver'}</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="note">Ajoute un lieu pour chaque prestation extérieure : les heures faites là-bas apparaîtront séparément dans l'export.</p>
          </Section>
        </div>
      </div>

      {addSite && <SiteSheet onClose={closeSite} />}
      {addKiosk && <KioskSheet sites={(sites.data ?? []).filter((s) => s.active)} onClose={closeKiosk} onCreated={setPair} />}
      {pair && <PairCodeSheet label={pair.label} code={pair.code} onClose={closePair} />}
      {rightsFor && <RightsSheet key={rightsFor.id} person={rightsFor} areas={areasOf(rightsFor.id)} onClose={closeRights} />}
      {mailSheet && mail.data && <MailSheet settings={mail.data} onClose={closeMail} />}
      {mercSheet && <MercSheet sources={merc.data ?? []} dashboardUrl={dashboard.data?.sheet_url ?? ''} keyAt={mercStatus.data?.key_created_at ?? null} onClose={closeMerc} />}
      {blSheet && <DeliverySheet settings={delivery.data ?? EMPTY_DELIVERY} onClose={closeBl} />}
      {zeltySheet && <ZeltySheet url={accounting.data?.zelty_url ?? ''} onClose={() => setZeltySheet(false)} />}
      {accSheet && <AccountantSheet access={accSheet} onClose={closeAcc} />}
    </Layout>
  );
}

/** Ce qu'un responsable peut modifier. */
function RightsSheet({ person, areas: old, onClose }: { person: Profile; areas: Area[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [areas, setAreas] = useState<Area[]>(old);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { error } = await supabase.rpc('set_rights', { p_profile: person.id, p_areas: areas });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('rights');
    toast(`Accès de ${person.first_name} enregistrés`);
    onClose();
  }
  return (
    <Sheet title={`Accès de ${fullName(person)}`} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <p className="note">Coche ce que {person.first_name} peut modifier. Tout le reste, {person.first_name} le consulte comme le reste de l'équipe.</p>
        <RightsPicker value={areas} onChange={setAreas} />
        <p className="note">Valable avec son compte (sur son téléphone, ou sur l'iPad après connexion par e-mail). Avec le code PIN de l'iPad, ce sont les droits d'un équipier.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
      </form>
    </Sheet>
  );
}

/** Accès de la comptable : son adresse e-mail, activer ou retirer. */
function AccountantSheet({ access, onClose }: { access: AccountantAccess | 'new'; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const old = access === 'new' ? null : access;
  const [email, setEmail] = useState(old?.email ?? '');
  const [name, setName] = useState(old?.name ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(op: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true);
    setErr('');
    const { error } = await op();
    setBusy(false);
    if (error) return setErr(/accountants_email_key/.test(error.message) ? 'Cette adresse a déjà un accès.' : /accountants_email_check/.test(error.message) ? "Vérifie l'adresse e-mail." : frError(error));
    await refresh('accountants');
    toast(done);
    onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const row = { email: email.trim(), name: name.trim() };
    void (old ? run(() => supabase.from('accountants').update(row).eq('id', old.id), 'Accès enregistré')
      : run(() => supabase.from('accountants').insert(row), 'Accès créé : elle peut créer son compte avec cette adresse'));
  }

  return (
    <Sheet title={old ? old.name || old.email : 'Accès comptable'} onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Nom" hint="Son nom ou celui du cabinet, pour t'y retrouver."><input className="in" id="acc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Cabinet Durand" /></Field>
        <Field label="Adresse e-mail" hint={old?.user_id ? 'Changer l\'adresse détache son compte : elle devra en créer un avec la nouvelle.' : 'Celle avec laquelle elle créera son compte.'}>
          <input className="in" id="acc-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        {old && (
          <div className="acts">
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => supabase.from('accountants').update({ active: !old.active }).eq('id', old.id), old.active ? 'Accès désactivé' : 'Accès réactivé')}>
              {old.active ? "Désactiver l'accès" : "Réactiver l'accès"}
            </button>
            <button type="button" className="btn no" disabled={busy} onClick={() => void run(() => supabase.from('accountants').delete().eq('id', old.id), 'Accès supprimé')}>Supprimer l'accès</button>
          </div>
        )}
      </form>
    </Sheet>
  );
}

/** Relier les mercuriales : liens des trois feuilles, clé de synchronisation et script Google à coller. */
/**
 * Ce qui bloque l'arrivée d'une feuille : le dernier envoi refusé, expliqué ; ou, après une nouvelle clé,
 * l'attente du nouveau script. Un refus plus ancien que la clé actuelle ne compte plus.
 */
function SyncProblem({ brand, linked, syncedAt, log, keyAt }: {
  brand: string; linked: boolean; syncedAt: string | null; log: { at: string; brand: string; ok: boolean; message: string }[]; keyAt: string | null;
}) {
  const last = log.find((l) => l.brand === brand);
  const key = keyAt ? new Date(keyAt).getTime() : 0;
  if (last && !last.ok && new Date(last.at).getTime() >= key) {
    return (
      <span className="sub err" data-merc-error={brand}>
        Dernier envoi refusé, {fmtDay(last.at)} à {fmtTime(last.at)} : {last.message}.
        {/clé refusée/i.test(last.message) && " Le script installé dans Google n'a pas la dernière clé : colle le dernier script créé ici à la place de tout le texte de ton projet, enregistre, puis lance « installer »."}
      </span>
    );
  }
  if (linked && key && (!syncedAt || new Date(syncedAt).getTime() < key)) {
    return <span className="sub" style={{ color: 'var(--warn)' }} data-merc-wait={brand}>En attente du nouveau script : colle-le dans Google, puis lance « installer ».</span>;
  }
  return null;
}

function MercSheet({ sources, dashboardUrl, keyAt, onClose }: { sources: MercSource[]; dashboardUrl: string; keyAt: string | null; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const urlOf = (b: string) => sources.find((s) => s.brand === b)?.sheet_url ?? '';
  const [sn, setSn] = useState(urlOf('saveurs_nomades'));
  const [cm, setCm] = useState(urlOf('comptoir'));
  const [nb, setNb] = useState(urlOf('nuba'));
  const [tb, setTb] = useState(dashboardUrl);
  const [script, setScript] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    const a = sheetId(sn), b = sheetId(cm), c = sheetId(nb), t = sheetId(tb);
    const bad = [nb.trim() && !c ? 'Nuba' : '', sn.trim() && !a ? 'Saveurs Nomades' : '', cm.trim() && !b ? 'Comptoir Méditerranéen' : '', tb.trim() && !t ? 'le tableau de bord' : ''].filter(Boolean);
    if (bad.length) return setErr(`Lien non reconnu pour ${bad.join(' et ')}. Ouvre la mercuriale dans Google Sheets et copie l'adresse en haut du navigateur : elle commence par https://docs.google.com/spreadsheets/d/`);
    if (!a && !b && !c && !t) return setErr('Colle le lien d\'au moins une mercuriale.');
    setBusy(true);
    setErr('');
    const clean = (id: string) => (id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : '');
    const { data, error } = await supabase.rpc('merc_new_key', { p_sn_url: clean(a), p_cm_url: clean(b), p_nuba_url: clean(c), p_dashboard_url: clean(t) });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('merc', 'dashboard');
    setScript(buildAppsScript({ url: projectUrl ?? '', publicKey: publicKey ?? '', syncKey: data as string, saveursNomades: a, comptoir: b, nuba: c, tableau: t, date: new Date().toLocaleDateString('fr-FR') }));
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(script);
      toast('Script copié');
    } catch {
      toast('Sélectionne le texte du script et copie-le à la main', 'bad');
    }
  }

  return (
    <Sheet title="Mercuriales Google Sheets" onClose={onClose}>
      {!script ? (
        <form className="form" onSubmit={create}>
          <p className="note">Ouvre chaque mercuriale dans Google Sheets et copie le lien de la barre d'adresse.</p>
          <Field label="Mercuriale Nuba (la carte du restaurant)"><input className="in" id="merc-nuba" inputMode="url" value={nb} onChange={(e) => setNb(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></Field>
          <Field label="Mercuriale Saveurs Nomades"><input className="in" id="merc-sn" inputMode="url" value={sn} onChange={(e) => setSn(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></Field>
          <Field label="Mercuriale Comptoir Méditerranéen"><input className="in" id="merc-cm" inputMode="url" value={cm} onChange={(e) => setCm(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></Field>
          <Field label="Tableau de bord financier (gérants seulement)" hint="Ton fichier « Tableau de bord financier » : il ne s'affiche qu'aux gérants.">
            <input className="in" id="merc-tableau" inputMode="url" value={tb} onChange={(e) => setTb(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
          </Field>
          {keyAt ? (
            <p className="err" data-testid="merc-replace">
              Tu as déjà un script, créé {fmtDay(keyAt)} à {fmtTime(keyAt)}. En créer un nouveau l'arrête : continue seulement si tu vas coller le nouveau tout de suite, à la place de l'ancien.
            </p>
          ) : <p className="note">Une nouvelle clé remplace l'ancienne : un script déjà installé cesse d'envoyer jusqu'à ce que tu le remplaces.</p>}
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Créer le script'}</button>
        </form>
      ) : (
        <div className="form">
          <ol className="note" style={{ paddingLeft: 18, display: 'grid', gap: 6 }}>
            <li>Copie le script ci-dessous. Il contient ta clé : il ne s'affichera plus.</li>
            <li>Sur ton ordinateur, ouvre script.google.com avec ton compte Google. Si tu as déjà un projet Nuba, ouvre-le ; sinon « Nouveau projet ».</li>
            <li>Efface tout le texte déjà présent, colle le script, et enregistre (icône disquette).</li>
            <li>En haut, choisis la fonction « installer », puis « Exécuter ». Google demande d'autoriser l'accès à tes feuilles : accepte (s'il parle d'application non validée : « Paramètres avancés », puis « Accéder »).</li>
            <li>Reviens ici : la date de réception s'affiche sous chaque mercuriale. Ensuite, tout se met à jour seul, toutes les dix minutes.</li>
            <li>Ne crée plus de nouveau script ensuite : chaque « Créer le script » change la clé et arrête celui que tu viens de coller.</li>
          </ol>
          <textarea className="in" id="merc-script" readOnly value={script} rows={8} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn pri block" onClick={() => void copy()}><Icon name="copy" />Copier le script</button>
          <button type="button" className="btn block" onClick={onClose}>C'est fait</button>
        </div>
      )}
    </Sheet>
  );
}

/** Lien vers la caisse Zelty, montré à la comptable. */
function ZeltySheet({ url: old, onClose }: { url: string; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [url, setUrl] = useState(old);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    const v = url.trim();
    if (v && !/^https:\/\/\S+$/.test(v)) return setErr('Le lien commence par https://');
    setBusy(true);
    const { error } = await supabase.from('accounting_settings').update({ zelty_url: v }).eq('id', true);
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('accounting');
    toast('Lien de la caisse enregistré');
    onClose();
  }
  return (
    <Sheet title="Caisse Zelty" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Lien du tableau de bord Zelty" hint="La comptable s'y connecte avec son propre accès Zelty (à créer dans Zelty).">
          <input className="in" id="zelty-url" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <p className="note">Plus tard, une fois l'abonnement et l'accès à Zelty activés, l'appli lira elle-même les Z de caisse de chaque jour et les encaissements.</p>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
      </form>
    </Sheet>
  );
}

const DELIVERY_FIELDS: (keyof DeliverySettings)[] = ['sender_name', 'sender_tagline', 'sender_address', 'sender_siret', 'sender_contact', 'client_name',
  'client_address', 'client_siret', 'place_name', 'place_address', 'place_access', 'slot', 'driver', 'dlc_days', 'lot_days_before'];

/** En-tête des bons de livraison : expéditeur, client, lieu, créneau, livreur, DLC et lot. */
function DeliverySheet({ settings, onClose }: { settings: DeliverySettings; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [f, setF] = useState<DeliverySettings>(settings);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  type TextKey = Exclude<keyof DeliverySettings, 'dlc_days' | 'lot_days_before' | 'updated_at'>;
  const text = (k: TextKey, label: string, hint?: string, placeholder?: string) => (
    <Field label={label} hint={hint}>
      <input className="in" id={`bl-${k}`} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} placeholder={placeholder} maxLength={k.endsWith('address') || k === 'place_access' ? 200 : 120} />
    </Field>
  );

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    // Seules ces colonnes se modifient : la base refuse les autres (id, auteur, date).
    const row = Object.fromEntries(DELIVERY_FIELDS.map((k) => [k, f[k]]));
    const { error } = await supabase.from('delivery_settings').update(row).eq('id', true);
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('delivery');
    toast('En-tête des bons de livraison enregistré');
    onClose();
  }

  return (
    <Sheet title="Bons de livraison" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <p className="note">Recopie l'en-tête de ton bon de livraison actuel (onglet « BL À IMPRIMER » de la mercuriale). Il s'imprime en haut et en bas de chaque bon.</p>
        <Section title="Ta société (expéditeur)">
          {text('sender_name', 'Nom')}
          {text('sender_tagline', 'Activité', undefined, 'Restauration et plats préparés')}
          {text('sender_address', 'Adresse du siège')}
          <div className="two">
            {text('sender_siret', 'SIRET')}
            {text('sender_contact', 'Contact exploitation', 'Le numéro à appeler le jour de la livraison.')}
          </div>
        </Section>
        <Section title="Client (facturation)">
          {text('client_name', 'Nom du client')}
          {text('client_address', 'Adresse de facturation')}
          {text('client_siret', 'SIRET du client')}
        </Section>
        <Section title="Livraison">
          {text('place_name', 'Lieu de réception')}
          {text('place_address', 'Adresse de livraison')}
          {text('place_access', "Instructions d'accès", undefined, 'Digicode, quai, interlocuteur…')}
          <div className="two">
            {text('slot', 'Créneau de livraison', undefined, '06h30')}
            {text('driver', 'Livreur', 'Laisse vide pour l\'écrire à la main.')}
          </div>
        </Section>
        <Section title="Traçabilité">
          <div className="two">
            <Field label="DLC : jours après la livraison">
              <input className="in" id="bl-dlc" type="number" min={0} max={30} value={f.dlc_days} onChange={(e) => setF((x) => ({ ...x, dlc_days: Math.max(0, Math.min(30, Number(e.target.value) || 0)) }))} />
            </Field>
            <Field label="Lot : jours avant la livraison" hint="Le lot porte la date de production : 1 = la veille.">
              <input className="in" id="bl-lot" type="number" min={0} max={14} value={f.lot_days_before} onChange={(e) => setF((x) => ({ ...x, lot_days_before: Math.max(0, Math.min(14, Number(e.target.value) || 0)) }))} />
            </Field>
          </div>
        </Section>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
      </form>
    </Sheet>
  );
}

/** Réglages des e-mails, avec la mise en route pas à pas. */
function MailSheet({ settings, onClose }: { settings: EmailSettings; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [f, setF] = useState<EmailSettings>({ ...settings, app_url: settings.app_url || appUrl() });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const text = (k: 'sender_name' | 'sender_email' | 'notify_email' | 'app_url' | 'signature') =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const flag = (k: 'enabled' | 'confirm_booking' | 'notify_booking' | 'notify_event' | 'notify_documents') =>
    (e: ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.checked }));

  async function save(e: FormEvent) {
    e.preventDefault();
    const mailOk = (v: string) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
    if (!mailOk(f.sender_email.trim()) || !mailOk(f.notify_email.trim())) return setErr('Vérifie les adresses e-mail.');
    if (f.enabled && !f.sender_email.trim()) return setErr("Indique l'adresse d'expédition, validée dans Brevo.");
    const url = f.app_url.trim().replace(/#.*$/, '');
    if (!/^https?:\/\/\S+\/$/.test(url)) return setErr("L'adresse de l'appli commence par https:// et finit par /.");
    setBusy(true);
    setErr('');
    const { error } = await supabase.from('email_settings').update({
      enabled: f.enabled, sender_name: f.sender_name.trim() || 'La Nuba', sender_email: f.sender_email.trim().toLowerCase(),
      notify_email: f.notify_email.trim().toLowerCase(), app_url: url, signature: f.signature.trim(),
      confirm_booking: f.confirm_booking, notify_booking: f.notify_booking, notify_event: f.notify_event,
      ...(f.notify_documents === undefined ? {} : { notify_documents: f.notify_documents }),
    }).eq('id', true);
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('emails');
    toast('Réglages des e-mails enregistrés');
    onClose();
  }

  const box = { width: 22, height: 22, flex: 'none' } as const;
  return (
    <Sheet title="E-mails" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <details className="guide">
          <summary>Mise en route (une seule fois, 15 minutes)</summary>
          <ol>
            <li>Crée un compte gratuit sur brevo.com (300 e-mails par jour).</li>
            <li>Dans Brevo, ajoute l'adresse qui enverra les e-mails (menu Expéditeurs) et valide-la. Pour éviter les courriers indésirables, authentifie aussi ton nom de domaine : Brevo donne les lignes à ajouter chez ton hébergeur.</li>
            <li>Dans Brevo, crée une clé API (menu « SMTP et API », onglet « Clés API »). Copie-la.</li>
            <li>Dans Supabase, ouvre Vault (dans Integrations, ou dans Project Settings). Ajoute un secret nommé exactement <b>brevo_api_key</b> et colle la clé comme valeur. Ne la colle nulle part ailleurs : ni ici, ni dans une conversation.</li>
            <li>Ici, coche « Envoyer les e-mails », remplis les adresses, enregistre, puis touche « Envoyer un essai ».</li>
          </ol>
          <p>
            Pour les e-mails des comptes de l'équipe (inscription, mot de passe oublié) : dans Supabase, Authentication, Emails, SMTP Settings, active le SMTP personnalisé avec l'hôte smtp-relay.brevo.com, le port 587, ton identifiant SMTP Brevo et une clé SMTP (menu « SMTP et API », onglet SMTP). Puis, dans Authentication, Rate Limits, monte la limite d'e-mails par heure.
          </p>
        </details>
        <label className="row" style={{ padding: 0, gap: 10 }}>
          <input id="mail-enabled" type="checkbox" checked={f.enabled} onChange={flag('enabled')} style={box} />
          <span className="t">Envoyer les e-mails</span>
        </label>
        <div className="two">
          <Field label="Nom de l'expéditeur"><input className="in" id="mail-name" value={f.sender_name} onChange={text('sender_name')} maxLength={60} /></Field>
          <Field label="Adresse d'expédition" hint="Validée dans Brevo."><input className="in" id="mail-from" type="email" inputMode="email" value={f.sender_email} onChange={text('sender_email')} placeholder="contact@ton-domaine.fr" /></Field>
        </div>
        <Field label="Adresse qui reçoit les alertes" hint="Réservations et demandes en ligne. Vide : pas d'alerte."><input className="in" id="mail-notify" type="email" inputMode="email" value={f.notify_email} onChange={text('notify_email')} /></Field>
        <label className="row" style={{ padding: 0, gap: 10 }}>
          <input id="mail-confirm" type="checkbox" checked={f.confirm_booking} onChange={flag('confirm_booking')} style={box} />
          <span className="grow"><span className="t">Confirmer au client</span><span className="sub">Chaque réservation en ligne et chaque annulation, s'il a donné son adresse</span></span>
        </label>
        <label className="row" style={{ padding: 0, gap: 10 }}>
          <input id="mail-booking" type="checkbox" checked={f.notify_booking} onChange={flag('notify_booking')} style={box} />
          <span className="grow"><span className="t">M'alerter des réservations en ligne</span><span className="sub">Nouvelle réservation, annulation par le client</span></span>
        </label>
        <label className="row" style={{ padding: 0, gap: 10 }}>
          <input id="mail-event" type="checkbox" checked={f.notify_event} onChange={flag('notify_event')} style={box} />
          <span className="grow"><span className="t">M'alerter des demandes de privatisation</span><span className="sub">Envoyées depuis la page publique ou le site</span></span>
        </label>
        {f.notify_documents !== undefined && (
          <label className="row" style={{ padding: 0, gap: 10 }}>
            <input id="mail-documents" type="checkbox" checked={f.notify_documents} onChange={flag('notify_documents')} style={box} />
            <span className="grow"><span className="t">Prévenir la comptable à chaque document envoyé</span><span className="sub">Arrêt de travail, pièce d'identité… et toi, pour les arrêts. Sans pièce jointe : elle l'ouvre dans son espace.</span></span>
          </label>
        )}
        <Field label="Signature"><textarea className="in" id="mail-signature" value={f.signature} onChange={text('signature')} maxLength={300} rows={2} /></Field>
        <Field label="Adresse de l'appli" hint="Sert aux liens dans les e-mails (consulter ou annuler une réservation)."><input className="in" id="mail-app" value={f.app_url} onChange={text('app_url')} /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
      </form>
    </Sheet>
  );
}

function SiteSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Site['kind']>('evenement');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.from('sites').insert({ name: name.trim(), kind });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('sites');
    toast('Lieu ajouté');
    onClose();
  }
  return (
    <Sheet title="Ajouter un lieu" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Nom du lieu">
          <input className="in" id="site-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Cocktail du 27 novembre" required />
        </Field>
        <Field label="Type">
          <select className="in" id="site-kind" value={kind} onChange={(e) => setKind(e.target.value as Site['kind'])}>
            <option value="evenement">Prestation extérieure</option>
            <option value="etablissement">Établissement</option>
          </select>
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Ajouter'}</button>
      </form>
    </Sheet>
  );
}

function KioskSheet({ sites, onClose, onCreated }: { sites: Site[]; onClose: () => void; onCreated: (p: { label: string; code: string }) => void }) {
  const refresh = useRefresh();
  const [site, setSite] = useState(sites[0]?.id ?? '');
  const [label, setLabel] = useState('iPad du bar');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!site) return setErr('Choisis un lieu.');
    setBusy(true);
    const { data, error } = await supabase.rpc('add_kiosk', { p_site: site, p_label: label });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('kiosks');
    onClose();
    onCreated({ label: label.trim(), code: (data as { code: string }).code });
  }
  return (
    <Sheet title="Ajouter une borne" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <Field label="Nom de la borne">
          <input className="in" id="kiosk-label" value={label} onChange={(e) => setLabel(e.target.value)} required />
        </Field>
        <Field label="Lieu">
          <select className="in" id="kiosk-site" value={site} onChange={(e) => setSite(e.target.value)}>
            {sites.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
          </select>
        </Field>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Créer la borne'}</button>
      </form>
    </Sheet>
  );
}

/** Code à taper sur l'appareil qui devient la borne. */
function PairCodeSheet({ label, code, onClose }: { label: string; code: string; onClose: () => void }) {
  return (
    <Sheet title={`Relier « ${label} »`} onClose={onClose}>
      <ol className="note" style={{ paddingLeft: 18, display: 'grid', gap: 4 }}>
        <li>Sur l'appareil qui servira de borne, ouvre l'appli Nuba depuis l'écran d'accueil.</li>
        <li>Si quelqu'un y est connecté : Mon compte, puis « Se déconnecter ».</li>
        <li>Sur l'écran de connexion, touche « Cet appareil est une borne de pointage ».</li>
        <li>Tape ce code :</li>
      </ol>
      <div className="panel">
        <p className="digits num" data-testid="pair-code">{code}</p>
        <p className="sub">Valable 10 minutes, pour un seul appareil.</p>
      </div>
      <p className="note">L'appareil relié s'ouvrira ensuite toujours sur la borne. S'il remplace un autre appareil, l'ancien n'affichera plus le code de pointage.</p>
      <button type="button" className="btn pri block" onClick={onClose}>C'est fait</button>
    </Sheet>
  );
}
