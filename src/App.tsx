import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { configured } from './lib/supabase';
import Account from './pages/Account';
import { Login, NewPassword, NoAccess, Setup, Splash } from './pages/Gate';
import Booking, { BookingManage, EventRequest } from './pages/Booking';
import Checklists from './pages/Checklists';
import Customers from './pages/Customers';
import Events from './pages/Events';
import Hygiene from './pages/Hygiene';
import Kiosk from './pages/Kiosk';
import More from './pages/More';
import Orders from './pages/Orders';
import Planning from './pages/Planning';
import Pointeuse, { PunchFromLink } from './pages/Pointeuse';
import Reservations from './pages/Reservations';
import Settings from './pages/Settings';
import Stocks from './pages/Stocks';
import Team from './pages/Team';
import Today from './pages/Today';

export default function App({ linkError }: { linkError: string }) {
  const { session, pin, profile, loading, problem, recovery } = useSession();
  const { pathname } = useLocation();

  if (!configured) return <Setup />;
  // La borne s'affiche sans compte : elle n'a que le jeton de son lien.
  if (pathname === '/borne') return <Kiosk />;
  // Pages publiques des clients : réserver une table, voir ou annuler sa réservation.
  if (pathname === '/reserver') return <Booking />;
  if (pathname === '/reservation') return <BookingManage />;
  if (pathname === '/privatiser') return <EventRequest />;
  if (loading) return <Splash />;
  // Pas de redirection : après la connexion, on reste sur la page demandée (par exemple le lien d'un QR code).
  if (!session && !pin) return <Login linkError={linkError} />;
  if (recovery && !pin) return <NewPassword />;
  if (problem) return <NoAccess reason="problem" />;
  if (!profile) return <NoAccess reason="unlinked" />;
  if (!profile.active) return <NoAccess reason="inactive" />;

  const gerant = profile.role === 'gerant';
  return (
    <Routes>
      <Route path="/" element={<Today />} />
      <Route path="/pointeuse" element={<Pointeuse />} />
      <Route path="/pointer" element={<PunchFromLink />} />
      <Route path="/checklists" element={<Checklists />} />
      <Route path="/reservations" element={<Reservations />} />
      <Route path="/evenements" element={<Events />} />
      <Route path="/clients" element={<Customers />} />
      <Route path="/hygiene" element={<Hygiene />} />
      <Route path="/stocks" element={<Stocks />} />
      <Route path="/commandes" element={<Orders />} />
      <Route path="/planning" element={<Planning />} />
      <Route path="/plus" element={<More />} />
      <Route path="/compte" element={<Account />} />
      {gerant && <Route path="/equipe" element={<Team />} />}
      {gerant && <Route path="/reglages" element={<Settings />} />}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
