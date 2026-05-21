import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { extractPairingToken, storeToken } from '../lib/token.js';

export function ScanAgain(): JSX.Element {
  const navigate = useNavigate();
  const [pairingText, setPairingText] = useState('');
  const [error, setError] = useState<string | null>(null);

  function saveToken(): void {
    const token = extractPairingToken(pairingText);
    if (!token) {
      setError('Paste the full pairing URL or token from `ap mobile pair`.');
      return;
    }
    storeToken(token);
    setError(null);
    navigate('/', { replace: true });
  }

  return (
    <main>
      <h1>Re-pair this phone</h1>
      <p className="warn">Your token is missing or expired.</p>
      <p>
        On the laptop, run:
        <br />
        <code>ap mobile pair</code>
      </p>
      <p className="muted">
        Then scan the QR code with your phone's camera. The page will reload with a fresh token.
      </p>
      <section className="repair-form" aria-label="Manual pairing">
        <label htmlFor="pairing-token">Pairing URL or token</label>
        <textarea
          id="pairing-token"
          value={pairingText}
          onChange={(event) => setPairingText(event.target.value)}
          rows={3}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {error ? <p className="error">{error}</p> : null}
        <button type="button" className="action-btn action-primary" onClick={saveToken}>
          Pair
        </button>
      </section>
    </main>
  );
}
