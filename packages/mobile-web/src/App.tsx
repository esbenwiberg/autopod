import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { readTokenFromHash } from './lib/token.js';
import { Landing } from './screens/Landing.js';
import { ScanAgain } from './screens/ScanAgain.js';

export function App(): JSX.Element {
  useEffect(() => {
    // Pair flow lands the phone with `#token=<hex>` in the URL — stash it +
    // scrub the fragment so the token doesn't sit in browser history.
    readTokenFromHash();
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/scan-again" element={<ScanAgain />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
