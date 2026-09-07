import type { DaemonHealthSummary } from '@autopod/shared';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, AuthRequiredError, apiFetch } from '../lib/api.js';
import { readStoredToken } from '../lib/token.js';

export function About(): JSX.Element {
  const [health, setHealth] = useState<DaemonHealthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<DaemonHealthSummary>('/health')
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch((err) => {
        if (cancelled || err instanceof AuthRequiredError) return;
        setError(err instanceof ApiError ? err.message : (err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tokenSet = Boolean(readStoredToken());

  return (
    <main>
      <Link to="/" className="back-link">
        ← Back
      </Link>
      <header className="app-header">
        <h1>About</h1>
      </header>

      <dl className="about-list">
        <dt>Daemon</dt>
        <dd>{health ? `v${health.version} · ${health.status}` : (error ?? 'checking…')}</dd>

        <dt>Release</dt>
        <dd>
          {health?.release?.commitSha ?? 'unavailable'}
          {health?.release?.dirty ? ' · modified source' : ''}
        </dd>
        <dt>Backup</dt>
        <dd>
          {health?.backup?.state ?? 'unavailable'} ·{' '}
          {health?.backup?.lastCompletedAt ?? 'freshness unverified'}
        </dd>

        <dt>Round trip</dt>
        <dd>{health ? `${health.requestDurationMs} ms` : '—'}</dd>

        <dt>Token</dt>
        <dd>{tokenSet ? 'set' : 'missing — run `ap mobile pair`'}</dd>

        <dt>Origin</dt>
        <dd>{typeof window !== 'undefined' ? window.location.host : '—'}</dd>
      </dl>

      <p className="muted">
        Need to re-pair? <Link to="/scan-again">Open re-pair screen</Link>.
      </p>
    </main>
  );
}
