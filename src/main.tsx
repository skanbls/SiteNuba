import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque';
import './styles/app.css';
import App from './App';
import { ToastProvider } from './components/ui';
import { SessionProvider } from './lib/session';
import { hasKiosk } from './pages/Kiosk';
import { supabase } from './lib/supabase';
import { startUpdates } from './lib/update';

startUpdates();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, retry: 1, refetchOnWindowFocus: true } },
});

async function start() {
  // Les liens des e-mails Supabase (confirmation, mot de passe oublié) reviennent avec leurs
  // informations après le # : on les laisse traiter avant de démarrer la navigation de l'appli.
  const hash = window.location.hash;
  const fromEmail = /access_token=|error_description=|error_code=/.test(hash);
  const recovery = /type=recovery/.test(hash);
  let linkError = '';
  if (/error_description=|error_code=/.test(hash)) {
    linkError = /expired|invalid/i.test(decodeURIComponent(hash))
      ? "Ce lien n'est plus valable. Demande-en un nouveau avec « Mot de passe oublié », ou connecte-toi."
      : "Le lien n'a pas fonctionné. Réessaie ou connecte-toi.";
  }
  await supabase.auth.getSession();
  const base = window.location.pathname + window.location.search;
  if (fromEmail) window.history.replaceState(null, '', base + '#/');
  // Un appareil relié à une borne (l'iPad fixe) s'ouvre toujours sur la borne, que quelqu'un y soit connecté ou non.
  // Seulement au lancement de l'appli : un lien précis (pointage, e-mail) garde sa destination.
  else if (/^#?\/?$/.test(hash) && hasKiosk()) window.history.replaceState(null, '', base + '#/borne');

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <SessionProvider initialRecovery={recovery}>
            <ToastProvider>
              <App linkError={linkError} />
            </ToastProvider>
          </SessionProvider>
        </HashRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
