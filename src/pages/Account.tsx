import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Field, Layout, Section, Spinner, useToast } from '../components/ui';
import { useMe, useSession } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { CONTRACT_LABEL, ROLE_LABEL, fullName } from '../lib/types';
import { buildLabel, checkForUpdate } from '../lib/update';
import { hasKiosk, unlinkKiosk } from './Kiosk';

/** Mon compte : mes informations, mon mot de passe, installer l'appli, me déconnecter. */
export default function Account() {
  const me = useMe();
  const { signOut, pin, reload } = useSession();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [kiosk, setKiosk] = useState(hasKiosk);
  const [checking, setChecking] = useState(false);
  const [code, setCode] = useState('');
  const [codeErr, setCodeErr] = useState('');

  async function savePin(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4}$/.test(code)) return setCodeErr('Le code PIN a 4 chiffres.');
    setBusy(true);
    setCodeErr('');
    const { error } = await supabase.rpc('set_my_pin', { p_pin: code });
    setBusy(false);
    if (error) return setCodeErr(frError(error));
    setCode('');
    toast(pin ? 'Code PIN changé. Identifie-toi avec le nouveau.' : 'Code PIN enregistré');
    // Changer de code ferme les sessions ouvertes avec l'ancien, donc celle-ci sur la borne.
    if (pin) await signOut();
    else await reload();
  }

  async function update() {
    setChecking(true);
    const found = await checkForUpdate();
    setChecking(false);
    toast(found ? "Nouvelle version trouvée : l'appli va se recharger" : 'Tu as déjà la dernière version');
  }

  async function changePw(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return setErr('Mot de passe trop court : 8 caractères au minimum.');
    setBusy(true);
    setErr('');
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr(frError(error));
    setPw('');
    toast('Mot de passe changé');
  }

  return (
    <Layout title="Mon compte">
      <div className="cols">
        <div className="stack">
          <Section>
            <div className="list">
              <div className="row"><div className="grow"><span className="sub">Nom</span><span className="t">{fullName(me)}</span></div></div>
              <div className="row"><div className="grow"><span className="sub">Adresse e-mail</span><span className="t">{me.email || 'Aucune : accès par l\'iPad seulement'}</span></div></div>
              <div className="row"><div className="grow"><span className="sub">Rôle et poste</span><span className="t">{[ROLE_LABEL[me.role], me.job].filter(Boolean).join(' · ')}</span></div></div>
              <div className="row"><div className="grow"><span className="sub">Contrat</span><span className="t">{CONTRACT_LABEL[me.contract]}{me.contract !== 'extra' ? ` · ${String(me.weekly_hours).replace('.', ',')} h par semaine` : ''}</span></div></div>
              {me.role === 'gerant' && (
                <Link className="row" to="/reglages"><Icon name="cog" /><div className="grow"><span className="t">Réglages</span><span className="sub">Bornes et lieux de pointage</span></div><span className="chev"><Icon name="chev" size={18} /></span></Link>
              )}
            </div>
            <p className="note">Une erreur dans ces informations ? Seul le gérant peut les modifier.</p>
          </Section>

          <Section title="Mon code PIN pour l'iPad">
            <form className="form" onSubmit={savePin}>
              <Field label={me.has_pin ? 'Nouveau code PIN' : 'Choisir mon code PIN'} hint="4 chiffres. Il sert à ouvrir l'appli à ton nom sur l'iPad de la Nuba, et à y pointer.">
                <input className="in" id="acc-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))} required />
              </Field>
              {codeErr && <p className="err" role="alert">{codeErr}</p>}
              <button className="btn" disabled={busy}>{busy ? <Spinner /> : me.has_pin ? 'Changer mon code PIN' : 'Enregistrer mon code PIN'}</button>
            </form>
          </Section>

          {!pin && <Section title="Changer mon mot de passe">
            <form className="form" onSubmit={changePw}>
              <Field label="Nouveau mot de passe" hint="8 caractères au minimum.">
                <input className="in" id="acc-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
              </Field>
              {err && <p className="err" role="alert">{err}</p>}
              <button className="btn" disabled={busy}>{busy ? <Spinner /> : 'Changer le mot de passe'}</button>
            </form>
          </Section>}
        </div>

        <div className="stack">
          {kiosk && (
            <Section title="Borne de pointage">
              <div className="list">
                <Link className="row" to="/borne"><Icon name="qr" /><div className="grow"><span className="t">Afficher la borne</span><span className="sub">Cet appareil est relié à une borne : l'appli s'ouvre dessus à chaque lancement.</span></div><span className="chev"><Icon name="chev" size={18} /></span></Link>
              </div>
              {me.role !== 'equipier' && (
                <button type="button" className="btn" onClick={() => { unlinkKiosk(); setKiosk(false); toast("Cet appareil n'est plus une borne"); }}>Ne plus utiliser cet appareil comme borne</button>
              )}
            </Section>
          )}
          <Section title="Installer l'appli sur mon téléphone">
            <div className="list">
              <div className="row"><div className="grow"><span className="t">iPhone et iPad</span><span className="sub">Dans Safari : bouton Partager, puis « Sur l'écran d'accueil ».</span></div></div>
              <div className="row"><div className="grow"><span className="t">Android</span><span className="sub">Dans Chrome : menu ⋮, puis « Installer l'application ».</span></div></div>
            </div>
          </Section>
          <Section title="Version de l'appli">
            <div className="list">
              <div className="row wrap">
                <div className="grow"><span className="t">Version du {buildLabel()}</span><span className="sub">L'appli se met à jour toute seule. Ce bouton sert en cas de doute.</span></div>
                <button type="button" className="btn sm" disabled={checking} onClick={() => void update()}>{checking ? <Spinner /> : 'Chercher une mise à jour'}</button>
              </div>
            </div>
          </Section>
          <button type="button" className="btn no" onClick={() => void signOut()}>{pin ? 'Terminer et revenir à la borne' : 'Se déconnecter'}</button>
        </div>
      </div>
    </Layout>
  );
}
