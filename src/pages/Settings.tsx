import { useCallback, useState, type FormEvent } from 'react';
import { Field, Layout, Loading, Section, Sheet, Spinner, useToast } from '../components/ui';
import { useKiosks, useRefresh, useSites } from '../lib/data';
import { frError, supabase } from '../lib/supabase';
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
  const [pair, setPair] = useState<{ label: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const closeSite = useCallback(() => setAddSite(false), []);
  const closeKiosk = useCallback(() => setAddKiosk(false), []);
  const closePair = useCallback(() => setPair(null), []);
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

  async function relink(id: string, label: string) {
    setBusy(true);
    const { data, error } = await supabase.rpc('start_kiosk_pairing', { p_kiosk: id });
    setBusy(false);
    if (error) return toast(frError(error), 'bad');
    setPair({ label, code: data as string });
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

      {addSite && <SiteSheet onClose={closeSite} />}
      {addKiosk && <KioskSheet sites={(sites.data ?? []).filter((s) => s.active)} onClose={closeKiosk} onCreated={setPair} />}
      {pair && <PairCodeSheet label={pair.label} code={pair.code} onClose={closePair} />}
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
