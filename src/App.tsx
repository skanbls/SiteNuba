import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { configured } from './lib/supabase';
import Account from './pages/Account';
import { Login, NewPassword, NoAccess, Setup, Splash } from './pages/Gate';
import Kiosk from './pages/Kiosk';
import Pointeuse, { PunchFromLink } from './pages/Pointeuse';
import Settings from './pages/Settings';
import Team from './pages/Team';
import Today from './pages/Today';

export default function App({ linkError }: { linkError: string }) {
  const { session, profile, loading, problem, recovery } = useSession();
  const { pathname } = useLocation();

  if (!configured) return <Setup />;
  // La borne s'affiche sans compte : elle n'a que le jeton de son lien.
  if (pathname === '/borne') return <Kiosk />;
  if (loading) return <Splash />;
  // Pas de redirection : après la connexion, on reste sur la page demandée (par exemple le lien d'un QR code).
  if (!session) return <Login linkError={linkError} />;
  if (recovery) return <NewPassword />;
  if (problem) return <NoAccess reason="problem" />;
  if (!profile) return <NoAccess reason="unlinked" />;
  if (!profile.active) return <NoAccess reason="inactive" />;

  const gerant = profile.role === 'gerant';
  return (
    <Routes>
      <Route path="/" element={<Today />} />
      <Route path="/pointeuse" element={<Pointeuse />} />
      <Route path="/pointer" element={<PunchFromLink />} />
      <Route path="/compte" element={<Account />} />
      {gerant && <Route path="/equipe" element={<Team />} />}
      {gerant && <Route path="/reglages" element={<Settings />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
