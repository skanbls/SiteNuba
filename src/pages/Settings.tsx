import { useCallback, useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Icon } from '../components/Icon';
import { Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useKiosks, useRefresh, useSites } from '../lib/data';
import { appUrl, frError, supabase } from '../lib/supabase';
import { fmtDay, fmtTime } from '../lib/time';
import type { Site } from '../lib/types';

/** Réglages du gérant : lieux où l'on pointe, et bornes qui affichent le QR code. */
export default function Settings() {
  const toast = useToast();
  const refresh = useRefresh();
  const sites = useSites();
  const kiosks = useKiosks();
  const [addSite, setAddSite] = useState(false);
  const [addKiosk, setAddKiosk] = useState(false);
  const [link, setLink] = useState('');
  const closeSite = useCallback(() => setAddSite(false), []);
  const closeKiosk = useCallback(() => setAddKiosk(false), []);
  const closeLink = useCallback(() => setLink(''), []);
  const live = (kiosks.data ?? []).filter((k) => !k.revoked_at);

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

  return (
    <Layout title="Réglages">
      <div className="cols">
        <Section title="Bornes de pointage" right={<button type="button" className="link" onClick={() => setAddKiosk(true)}>Ajouter une borne</button>}>
          {kiosks.isLoading ? <Loading /> : (
            <div className="list">
              {live.length === 0 && <p className="empty">Aucune borne. Ajoute-en une, puis relie-la à l'iPad qui restera à la Nuba.</p>}
              {live.map((k) => (
                <div className="row wrap" key={k.id}>
                  <div className="grow">
                    <span className="t">{k.label}</span>
                    <span className="sub">{k.sites?.name} · {k.last_seen_at ? `vue ${fmtDay(k.last_seen_at)} à ${fmtTime(k.last_seen_at)}` : 'jamais ouverte'}</span>
                  </div>
                  <button type="button" className="btn sm no" onClick={() => void revoke(k.id)}>Désactiver</button>
                </div>
              ))}
            </div>
          )}
          <p className="note">Une borne est un appareil qui affiche le QR code de pointage : en général un iPad fixe. Si l'appareil est perdu ou remplacé, désactive sa borne et crée-en une autre.</p>
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

      {addSite && <SiteSheet onClose={closeSite} />}
      {addKiosk && <KioskSheet sites={(sites.data ?? []).filter((s) => s.active)} onClose={closeKiosk} onCreated={setLink} />}
      {link && <KioskLinkSheet link={link} onClose={closeLink} />}
    </Layout>
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

function KioskSheet({ sites, onClose, onCreated }: { sites: Site[]; onClose: () => void; onCreated: (link: string) => void }) {
  const refresh = useRefresh();
  const [site, setSite] = useState(sites[0]?.id ?? '');
  const [label, setLabel] = useState('iPad du bar');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!site) return setErr('Choisis un lieu.');
    setBusy(true);
    const { data, error } = await supabase.rpc('create_kiosk', { p_site: site, p_label: label });
    setBusy(false);
    if (error) return setErr(frError(error));
    await refresh('kiosks');
    onClose();
    onCreated(`${appUrl()}#/borne?t=${data as string}`);
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

/** Le lien d'une borne ne s'affiche qu'à sa création : il contient son jeton. */
function KioskLinkSheet({ link, onClose }: { link: string; onClose: () => void }) {
  const toast = useToast();
  const [svg, setSvg] = useState('');
  useEffect(() => {
    void QRCode.toString(link, { type: 'svg', margin: 0, errorCorrectionLevel: 'L', color: { dark: '#161a2e', light: '#ffffff' } }).then(setSvg);
  }, [link]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      toast('Lien de la borne copié');
    } catch {
      toast('Copie impossible : sélectionne le lien à la main', 'bad');
    }
  }
  return (
    <Sheet title="Borne créée" onClose={onClose}>
      <p>Sur l'iPad, ouvre l'appli Nuba installée sur l'écran d'accueil, touche « Cet appareil est une borne de pointage », puis présente ce QR code devant sa caméra avant.</p>
      <div className="panel">
        <div className="qr" role="img" aria-label="QR code du lien de la borne" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      <input className="in" id="kiosk-link" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Lien de la borne" />
      <button type="button" className="btn pri block" onClick={() => void copy()}><Icon name="copy" />Copier le lien</button>
      <p className="note">Sans caméra, copie ce lien et colle-le sur l'iPad au même endroit. Ce QR code et ce lien ne s'afficheront plus après la fermeture de cette fenêtre. Ne les partage pas : ils suffisent à afficher le code de pointage.</p>
    </Sheet>
  );
}
