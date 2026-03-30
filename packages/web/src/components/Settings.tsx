import type React from 'react';
import { useState } from 'react';
import type { StoredConfig } from '../store/config.js';

interface SettingsProps {
  current: StoredConfig | null;
  onSave: (config: StoredConfig) => void;
}

export function Settings({ current, onSave }: SettingsProps): React.ReactElement {
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? 'http://localhost:3100');
  const [token, setToken] = useState(current?.token ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ baseUrl: baseUrl.trim(), token: token.trim() });
  };

  return (
    <div style={{ maxWidth: 480, margin: '60px auto', padding: '0 16px' }}>
      <h1 style={{ marginBottom: 8, fontSize: 22, fontWeight: 700 }}>Connect to daemon</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 28, fontSize: 13 }}>
        Enter the URL of your running autopod daemon and a valid auth token. In dev mode the daemon
        accepts any non-empty token.
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span style={{ color: 'var(--text-muted)' }}>Daemon URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:3100"
            required
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span style={{ color: 'var(--text-muted)' }}>Auth token</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token (run: ap login)"
            required
          />
        </label>
        <button type="submit" className="btn-primary" style={{ marginTop: 6 }}>
          Connect
        </button>
      </form>
    </div>
  );
}
