import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { BrandHead, Logo } from '../components/Logo';
import { Field, Spinner } from '../components/ui';
import { useSession } from '../lib/session';
import { appUrl, frError, supabase } from '../lib/supabase';
import { buildLabel } from '../lib/update';
import { hasKiosk } from './Kiosk';

/** Écran d'attente au démarrage. */
export const Splash = () => (
  <div className="full">
    <div className="splash">
      <Logo />
      <Spinner />
    </div>
  </div>
);

/** L'appli n'a pas encore l'adresse de sa base de données. */
export const Setup = () => (
  <div className="full">
    <div className="card">
      <BrandHead />
      <h1 className="vh">Nuba</h1>
      <p>L'appli n'est pas encore reliée à sa base de données.</p>
      <p className="note">Renseigne VITE_SUPABASE_URL et VITE_SUPABASE_KEY (voir le fichier README), puis reconstruis l'appli.</p>
    </div>
  </div>
);

type Mode = 'in' | 'up' | 'forgot';

/** Connexion, création de compte et mot de passe oublié. */
export function Login({ linkError }: { linkError: string }) {
  const [mode, setMode] = useState<Mode>('in');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(linkError);
  const [msg, setMsg] = useState('');

  const go = (m: Mode) => {
    setMode(m);
    setErr('');
    setMsg('');
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setMsg('');
    setBusy(true);
    try {
      const mail = email.trim().toLowerCase();
      if (mode === 'in') {
        const { error } = await supabase.auth.signInWithPassword({ email: mail, password: pw });
        if (error) throw error;
      } else if (mode === 'up') {
        if (pw.length < 8) throw new Error('weak_password');
        const { data, error } = await supabase.auth.signUp({
          email: mail,
          password: pw,
          options: { emailRedirectTo: appUrl(), data: { first_name: name.trim() } },
        });
        if (error) throw error;
        // Supabase répond sans erreur quand l'adresse a déjà un compte, pour ne pas le révéler.
        if (data.user && data.user.identities && data.user.identities.length === 0) throw new Error('user_already_exists');
        if (!data.session) {
          setMode('in');
          setPw('');
          setMsg('Compte créé. Ouvre le lien reçu par e-mail pour confirmer ton adresse, puis connecte-toi ici.');
        }
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(mail, { redirectTo: appUrl() });
        if (error) throw error;
        setMsg('Si un compte existe à cette adresse, un e-mail vient de partir avec un lien pour choisir un nouveau mot de passe.');
      }
    } catch (e) {
      setErr(frError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="full">
      <div className="card">
        <BrandHead />
        <div>
          <h1 className="vh">Nuba Gestion</h1>
          <p className="sub center">{mode === 'in' ? "Connecte-toi pour accéder à l'appli de l'équipe." : mode === 'up' ? "Utilise l'adresse e-mail que le gérant a enregistrée pour toi." : 'Reçois un lien pour choisir un nouveau mot de passe.'}</p>
        </div>
        <form className="form" onSubmit={submit}>
          {mode === 'up' && (
            <Field label="Prénom">
              <input className="in" id="login-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" required />
            </Field>
          )}
          <Field label="Adresse e-mail">
            <input className="in" id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" required />
          </Field>
          {mode !== 'forgot' && (
            <Field label="Mot de passe" hint={mode === 'up' ? '8 caractères au minimum.' : undefined}>
              <input className="in" id="login-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'up' ? 'new-password' : 'current-password'} required />
            </Field>
          )}
          {err && <p className="err" role="alert">{err}</p>}
          {msg && <p className="okmsg" role="status">{msg}</p>}
          <button className="btn pri block" disabled={busy}>
            {busy ? <Spinner /> : mode === 'in' ? 'Se connecter' : mode === 'up' ? 'Créer mon compte' : 'Recevoir le lien'}
          </button>
        </form>
        <div className="acts">
          {mode !== 'in' && <button type="button" className="btn" onClick={() => go('in')}>J'ai déjà un compte</button>}
          {mode !== 'up' && <button type="button" className="btn" onClick={() => go('up')}>Créer mon compte</button>}
          {mode === 'in' && <button type="button" className="btn" onClick={() => go('forgot')}>Mot de passe oublié</button>}
        </div>
        <Link className="link center" to="/borne">{hasKiosk() ? 'Revenir à la borne de pointage' : 'Cet appareil est une borne de pointage'}</Link>
        <p className="sub center" data-testid="version">Version du {buildLabel()}</p>
      </div>
    </div>
  );
}

/** Après un lien « mot de passe oublié » : choisir le nouveau mot de passe. */
export function NewPassword() {
  const { endRecovery } = useSession();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw.length < 8) return setErr('Mot de passe trop court : 8 caractères au minimum.');
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) return setErr(frError(error));
    endRecovery();
  }

  return (
    <div className="full">
      <div className="card">
        <div>
          <h1>Nouveau mot de passe</h1>
          <p className="sub">Choisis-le maintenant, tu seras ensuite connecté.</p>
        </div>
        <form className="form" onSubmit={submit}>
          <Field label="Nouveau mot de passe" hint="8 caractères au minimum.">
            <input className="in" id="new-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
          </Field>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="btn pri block" disabled={busy}>{busy ? <Spinner /> : 'Enregistrer'}</button>
        </form>
      </div>
    </div>
  );
}

/** Connecté, mais sans fiche d'équipe utilisable. */
export function NoAccess({ reason }: { reason: 'unlinked' | 'inactive' | 'problem' }) {
  const { session, problem, reload, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    await reload();
    setBusy(false);
  };
  return (
    <div className="full">
      <div className="card">
        <div>
          <h1>{reason === 'problem' ? 'Connexion impossible' : reason === 'inactive' ? 'Compte désactivé' : 'Compte en attente'}</h1>
          <p className="sub">{session?.user.email}</p>
        </div>
        {reason === 'unlinked' && <p>Ton compte existe, mais il n'est pas encore rattaché à l'équipe. Demande au gérant de t'ajouter dans l'appli avec cette adresse e-mail exacte, puis réessaie.</p>}
        {reason === 'inactive' && <p>Le gérant a désactivé ton accès. Contacte-le si c'est une erreur.</p>}
        {reason === 'problem' && <p className="err" role="alert">{problem}</p>}
        <div className="acts">
          <button type="button" className="btn pri" onClick={retry} disabled={busy}>{busy ? <Spinner /> : 'Réessayer'}</button>
          <button type="button" className="btn" onClick={() => void signOut()}>Se déconnecter</button>
        </div>
      </div>
    </div>
  );
}
