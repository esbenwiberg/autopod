import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { readStoredToken, readTokenFromHash } from './lib/token.js';
import { WsClient } from './lib/ws-client.js';
import { Create } from './screens/Create.js';
import { Landing } from './screens/Landing.js';
import { PodDetail } from './screens/PodDetail.js';
import { ScanAgain } from './screens/ScanAgain.js';
import { usePodsStore } from './store/pods.js';

export function App(): JSX.Element {
  useEffect(() => {
    // Pair flow lands the phone with `#token=<hex>` in the URL — stash it +
    // scrub the fragment so the token doesn't sit in browser history.
    readTokenFromHash();

    if (!readStoredToken()) return undefined;

    const store = usePodsStore.getState();
    const ws = new WsClient({
      onEvent: (event) => usePodsStore.getState().applyEvent(event),
      onConnectionChange: (connected) => usePodsStore.getState().setConnected(connected),
      // Server gave up on incremental replay — do a full refetch.
      onReplayTruncated: () => void store.refresh(),
    });
    ws.start();
    return () => ws.stop();
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/create" element={<Create />} />
        <Route path="/pod/:id" element={<PodDetail />} />
        <Route path="/scan-again" element={<ScanAgain />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
