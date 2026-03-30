import type React from 'react';
import { useState } from 'react';
import { AutopodWebClient, type DaemonAppConfig } from '../api/client.js';
import type { StoredConfig } from '../store/config.js';

interface SettingsProps {
  current: StoredConfig | null;
  onSave: (config: StoredConfig, appConfig: DaemonAppConfig) => void;
}

export function Settings({ current, onSave }: SettingsProps): React.ReactElement {
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? 'http://localhost:3100');
  const [devToken, setDevToken] = useState(current?.devToken ?? '');
  const [appConfig, setAppConfig] = useState<DaemonAppConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const cfg = await AutopodWebClient.fetchAppConfig(baseUrl.trim());
      setAppConfig(cfg);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? `Could not reach daemon: ${err.message}` : 'Could not reach daemon',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleDevTokenSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!appConfig) return;
    onSave({ baseUrl: baseUrl.trim(), devToken: devToken.trim() }, appConfig);
  };

  const handleMsalLogin = () => {
    if (!appConfig) return;
    // Save the URL so we can restore it after the MSAL redirect
    onSave({ baseUrl: baseUrl.trim() }, appConfig);
  };

  const containerStyle: React.CSSProperties = {
    maxWidth: 480,
    margin: '60px auto',
    padding: '0 16px',
  };

  const headingStyle: React.CSSProperties = {
    marginBottom: 8,
    fontSize: 22,
    fontWeight: 700,
  };

  const subtitleStyle: React.CSSProperties = {
    color: 'var(--text-muted)',
    marginBottom: 28,
    fontSize: 13,
  };

  const formStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  };

  const labelStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 13,
  };

  // Step 1: enter daemon URL
  if (!appConfig) {
    return (
      <div style={containerStyle}>
        <h1 style={headingStyle}>Connect to daemon</h1>
        <p style={subtitleStyle}>Enter the URL of your running autopod daemon.</p>
        <form onSubmit={handleUrlSubmit} style={formStyle}>
          <label style={labelStyle}>
            <span style={{ color: 'var(--text-muted)' }}>Daemon URL</span>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:3100"
              required
            />
          </label>
          {error && <p style={{ color: 'var(--error)', fontSize: 13 }}>{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Connecting…' : 'Continue'}
          </button>
        </form>
      </div>
    );
  }

  // Step 2a: dev mode — paste a token
  if (appConfig.devMode) {
    return (
      <div style={containerStyle}>
        <h1 style={headingStyle}>Sign in</h1>
        <p style={subtitleStyle}>
          Dev mode — the daemon accepts any non-empty token. Run{' '}
          <code style={{ color: 'var(--accent)' }}>ap login</code> to get a real token, or just type
          anything.
        </p>
        <form onSubmit={handleDevTokenSubmit} style={formStyle}>
          <label style={labelStyle}>
            <span style={{ color: 'var(--text-muted)' }}>Auth token</span>
            <input
              type="password"
              value={devToken}
              onChange={(e) => setDevToken(e.target.value)}
              placeholder="any value works in dev mode"
              required
            />
          </label>
          <button type="submit" className="btn-primary">
            Connect
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setAppConfig(null)}
            style={{ fontSize: 12 }}
          >
            ← Change URL
          </button>
        </form>
      </div>
    );
  }

  // Step 2b: production — MSAL login
  return (
    <div style={containerStyle}>
      <h1 style={headingStyle}>Sign in</h1>
      <p style={subtitleStyle}>
        Sign in with your Microsoft account to access the autopod daemon at{' '}
        <span style={{ color: 'var(--accent)' }}>{baseUrl}</span>.
      </p>
      <div style={formStyle}>
        <button type="button" className="btn-primary" onClick={handleMsalLogin}>
          Sign in with Microsoft
        </button>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setAppConfig(null)}
          style={{ fontSize: 12 }}
        >
          ← Change URL
        </button>
      </div>
    </div>
  );
}
