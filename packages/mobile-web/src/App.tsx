import { useEffect, useState } from 'react';
import { readStoredToken, readTokenFromHash } from './lib/token.js';

export function App(): JSX.Element {
  const [tokenLoaded, setTokenLoaded] = useState(false);

  useEffect(() => {
    // Pair flow lands the phone here with `#token=<hex>` in the URL.
    // Stash it and scrub the fragment so the token doesn't sit in
    // browser history / shared screenshots.
    readTokenFromHash();
    setTokenLoaded(Boolean(readStoredToken()));
  }, []);

  return (
    <main>
      <h1>Autopod</h1>
      <p className={tokenLoaded ? 'ok' : 'warn'}>
        {tokenLoaded ? 'token loaded ✓' : 'no token — scan the QR from `ap mobile pair`'}
      </p>
    </main>
  );
}
