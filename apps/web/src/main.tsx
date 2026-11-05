import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { desktop, hasToken, signInFromUrl } from './api.ts';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { trayMenu } from './platform.ts';
import Shell from './Shell.tsx';
import './styles.css';
import { initTheme } from './theme.ts';

initTheme();

function SignedOut({ error }: { error: string | null }) {
  return (
    <div className="signin">
      <div className="brand">
        <span className="mark" aria-hidden="true" />
        bloomterm
      </div>
      {error && <p className="down">{error}</p>}
      {desktop ? (
        <p>Choose Open bloomterm in {trayMenu} to sign in again.</p>
      ) : (
        <p>
          Open this page with <code>pnpm bt ui</code>. It signs this browser in with a one-time link.
        </p>
      )}
    </div>
  );
}

function Root({ error: initialError }: { error: string | null }) {
  const [signedIn, setSignedIn] = useState(hasToken());
  const [error, setError] = useState(initialError);
  useEffect(() => {
    const off = () => setSignedIn(false);
    // A `bt ui` link can land in a tab that's already open: only the fragment changes.
    const onHash = () =>
      void signInFromUrl()
        .catch((e: Error) => e.message)
        .then((err) => {
          if (err) setError(err);
          setSignedIn(hasToken());
        });
    window.addEventListener('bloomterm:signed-out', off);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('bloomterm:signed-out', off);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  return signedIn ? <Shell /> : <SignedOut error={error} />;
}

void signInFromUrl()
  .catch((e: Error) => e.message)
  .then((error) =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Root error={error} />
      </StrictMode>,
    ),
  );
