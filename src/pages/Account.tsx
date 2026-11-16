import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Field, Layout, Section, Spinner, useToast } from '../components/ui';
import { useMe, useSession } from '../lib/session';
import { frError, supabase } from '../lib/supabase';
import { CONTRACT_LABEL, ROLE_LABEL, fullName } from '../lib/types';

/** Mon compte : mes informations, mon mot de passe, installer l'appli, me déconnecter. */
export default function Account() {
  const me = useMe();
  const { signOut } = useSession();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

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
              <div className="row"><div className="grow"><span className="sub">Adresse e-mail</span><span className="t">{me.email}</span></div></div>
              <div className="row"><div className="grow"><span className="sub">Rôle et poste</span><span className="t">{[ROLE_LABEL[me.role], me.job].filter(Boolean).join(' · ')}</span></div></div>
              <div className="row"><div className="grow"><span className="sub">Contrat</span><span className="t">{CONTRACT_LABEL[me.contract]}{me.contract !== 'extra' ? ` · ${String(me.weekly_hours).replace('.', ',')} h par semaine` : ''}</span></div></div>
              {me.role === 'gerant' && (
                <Link className="row" to="/reglages"><Icon name="cog" /><div className="grow"><span className="t">Réglages</span><span className="sub">Bornes et lieux de pointage</span></div><span className="chev"><Icon name="chev" size={18} /></span></Link>
              )}
            </div>
            <p className="note">Une erreur dans ces informations ? Seul le gérant peut les modifier.</p>
          </Section>

          <Section title="Changer mon mot de passe">
            <form className="form" onSubmit={changePw}>
              <Field label="Nouveau mot de passe" hint="8 caractères au minimum.">
                <input className="in" id="acc-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
              </Field>
              {err && <p className="err" role="alert">{err}</p>}
              <button className="btn" disabled={busy}>{busy ? <Spinner /> : 'Changer le mot de passe'}</button>
            </form>
          </Section>
        </div>

        <div className="stack">
          <Section title="Installer l'appli sur mon téléphone">
            <div className="list">
              <div className="row"><div className="grow"><span className="t">iPhone et iPad</span><span className="sub">Dans Safari : bouton Partager, puis « Sur l'écran d'accueil ».</span></div></div>
              <div className="row"><div className="grow"><span className="t">Android</span><span className="sub">Dans Chrome : menu ⋮, puis « Installer l'application ».</span></div></div>
            </div>
          </Section>
          <button type="button" className="btn no" onClick={() => void signOut()}>Se déconnecter</button>
        </div>
      </div>
    </Layout>
  );
}
