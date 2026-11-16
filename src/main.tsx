import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque';
import './styles/app.css';
import App from './App';
import { ToastProvider } from './components/ui';
import { SessionProvider } from './lib/session';
import { supabase } from './lib/supabase';

registerSW({ immediate: true });

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true } },
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
  if (fromEmail) window.history.replaceState(null, '', window.location.pathname + window.location.search + '#/');

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
