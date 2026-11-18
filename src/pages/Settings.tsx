import { useCallback, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon';
import { RightsPicker } from '../components/Rights';
import { Avatar, Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useQuery } from '@tanstack/react-query';
import { buildAppsScript, sheetId } from '../lib/appsScript';
import { useAllRights, useEmailLog, useEmailSettings, useKiosks, useMercSources, useRefresh, useSites, useTeam } from '../lib/data';
import type { MercSource } from '../lib/production';
import { AREAS, type Area } from '../lib/rights';
import { appUrl, frError, key as publicKey, supabase, url as projectUrl } from '../lib/supabase';
import { fmtDay, fmtTime } from '../lib/time';
import { fullName, type EmailLogEntry, type EmailSettings, type Profile, type Site } from '../lib/types';

const ADMIN_LINKS: [string, IconName, string, string][] = [
  ['/equipe', 'team', 'Équipe', 'Fiches, rôles, codes PIN, accès et dossiers Drive'],
  ['/checklists', 'check', 'Checklists', 'Nouvelle liste, ou « Modifier cette liste »'],
  ['/hygiene', 'thermo', 'Hygiène', 'Enceintes froides, plan de nettoyage'],
  ['/stocks', 'box', 'Stocks', 'Produits, seuils d\'alerte, quantités voulues, prix'],
  ['/commandes', 'truck', 'Fournisseurs', 'Coordonnées, jours de livraison, minimum de commande'],
  ['/fiches', 'list', 'Fiches techniques', 'Recettes, grammages, prix de vente'],
  ['/production', 'pot', 'Production', 'Fiches et commandes des mercuriales : elles se modifient dans Google Sheets'],
  ['/procedures', 'doc', 'Procédures', 'Consignes de l\'équipe, lecture à confirmer'],
  ['/planning', 'cal', 'Planning', 'Services de la semaine, congés'],
  ['/reservations', 'book', 'Réservations', 'Horaires, créneaux, lien et code pour le site'],
  ['/maintenance', 'tool', 'Échéances', 'Contrôles, contrats, documents de l\'équipe'],
];

const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;

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
                {(merc.data ?? []).map((m) => {
                  // Dernier envoi de cette mercuriale : s'il a été refusé, on dit pourquoi.
                  const last = (mercStatus.data?.log ?? []).find((l) => l.brand === m.brand);
                  const refused = last && !last.ok ? last : null;
                  return (
                    <div className="row wrap" key={m.brand} data-merc={m.brand}>
                      <div className="grow">
                        <span className="t">{m.label}</span>
                        <span className="sub">{m.synced_at ? `Reçue ${fmtDay(m.synced_at)} à ${fmtTime(m.synced_at)} · ${plural(m.counts.recipes ?? 0, 'fiche')}, ${plural(m.counts.orders ?? 0, 'commande')}` : 'Jamais reçue'}</span>
                        {refused && <span className="sub err" data-merc-error={m.brand}>Dernier envoi refusé, {fmtDay(refused.at)} à {fmtTime(refused.at)} : {refused.message}</span>}
                      </div>
                      {m.sheet_url && <div className="end"><a className="btn sm" href={m.sheet_url} target="_blank" rel="noopener noreferrer">Ouvrir</a></div>}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="note">Les fiches, les commandes et les prix des mercuriales arrivent dans Production toutes les dix minutes, par un petit script Google que tu installes une fois.</p>
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
      {mercSheet && <MercSheet sources={merc.data ?? []} onClose={closeMerc} />}
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

/** Relier les mercuriales : liens des deux feuilles, clé de synchronisation et script Google à coller. */
function MercSheet({ sources, onClose }: { sources: MercSource[]; onClose: () => void }) {
  const toast = useToast();
  const refresh = useRefresh();
  const urlOf = (b: string) => sources.find((s) => s.brand === b)?.sheet_url ?? '';
  const [sn, setSn] = useState(urlOf('saveurs_nomades'));
  const [cm, setCm] = useState(urlOf('comptoir'));
  const [script, setScript] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    const a = sheetId(sn), b = sheetId(cm);
    const bad = [sn.trim() && !a ? 'Saveurs Nomades' : '', cm.trim() && !b ? 'Comptoir Méditerranéen' : ''].filter(Boolean);
    if (bad.length) return setErr(`Lien non reconnu pour ${bad.join(' et ')}. Ouvre la mercuriale dans Google Sheets et copie l'adresse en haut du navigateur : elle commence par https://docs.google.com/spreadsheets/d/`);
    if (!a && !b) return setErr('Colle le lien d\'au moins une mercuriale.');
    setBusy(true);
    setErr('');
    const clean = (id: string) => (id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : '');
    const { data, error } = await supabase.rpc('merc_new_key', { p_sn_url: clean(a), p_cm_url: clean(b) });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('merc');
    setScript(buildAppsScript({ url: projectUrl ?? '', publicKey: publicKey ?? '', syncKey: data as string, saveursNomades: a, comptoir: b, date: new Date().toLocaleDateString('fr-FR') }));
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
          <Field label="Mercuriale Saveurs Nomades"><input className="in" id="merc-sn" inputMode="url" value={sn} onChange={(e) => setSn(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></Field>
          <Field label="Mercuriale Comptoir Méditerranéen"><input className="in" id="merc-cm" inputMode="url" value={cm} onChange={(e) => setCm(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" /></Field>
          <p className="note">Une nouvelle clé remplace l'ancienne : un script déjà installé cesse d'envoyer jusqu'à ce que tu le remplaces.</p>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Créer le script'}</button>
        </form>
      ) : (
        <div className="form">
          <ol className="note" style={{ paddingLeft: 18, display: 'grid', gap: 6 }}>
            <li>Copie le script ci-dessous. Il contient ta clé : il ne s'affichera plus.</li>
            <li>Sur ton ordinateur, ouvre script.google.com avec ton compte Google, puis « Nouveau projet ».</li>
            <li>Efface le texte déjà présent, colle le script, et enregistre (icône disquette).</li>
            <li>En haut, choisis la fonction « installer », puis « Exécuter ». Google demande d'autoriser l'accès à tes feuilles : accepte (s'il parle d'application non validée : « Paramètres avancés », puis « Accéder »).</li>
            <li>Reviens ici : la date de réception s'affiche sous chaque mercuriale. Ensuite, tout se met à jour seul, toutes les dix minutes.</li>
          </ol>
          <textarea className="in" id="merc-script" readOnly value={script} rows={8} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="btn pri block" onClick={() => void copy()}><Icon name="copy" />Copier le script</button>
          <button type="button" className="btn block" onClick={onClose}>C'est fait</button>
        </div>
      )}
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
  const flag = (k: 'enabled' | 'confirm_booking' | 'notify_booking' | 'notify_event') =>
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
