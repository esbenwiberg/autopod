import type { JSX } from 'react';
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { ManagedPodSummary } from '../store/managed-pods.js';
import { useManagedPodsStore } from '../store/managed-pods.js';

const POLL_INTERVAL_MS = 5_000;

export function ManagedPods(): JSX.Element {
  const pods = useManagedPodsStore((state) => state.pods);
  const loading = useManagedPodsStore((state) => state.loading);
  const loaded = useManagedPodsStore((state) => state.loaded);
  const error = useManagedPodsStore((state) => state.error);
  const refresh = useManagedPodsStore((state) => state.refresh);

  useManagedPodPolling(refresh);

  return (
    <main>
      <Link to="/" className="back-link">
        ← Back
      </Link>
      <header className="app-header">
        <div>
          <h1>Managed Pods</h1>
          <p className="muted managed-subtitle">Read-only Dispatcher attempts</p>
        </div>
        <button
          type="button"
          className="refresh-button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh managed pods"
        >
          {loading ? '…' : '↻'}
        </button>
      </header>

      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="pod-list" aria-label="Managed pods">
        {pods.length === 0 && loaded && !loading ? (
          <p className="empty">No managed attempts are visible for this enrolled installation.</p>
        ) : (
          pods.map((pod) => <ManagedPodCard key={pod.podId} pod={pod} />)
        )}
        {pods.length === 0 && (!loaded || loading) ? (
          <p className="empty">Loading managed pods…</p>
        ) : null}
      </section>
    </main>
  );
}

function ManagedPodCard({ pod }: { pod: ManagedPodSummary }): JSX.Element {
  return (
    <Link to={`/managed-pod/${encodeURIComponent(pod.podId)}`} className="pod-card managed-card">
      <div className="pod-card-row">
        <span className="managed-card-id">{pod.podId}</span>
        <ManagedStateChip state={pod.state} />
      </div>
      <div className="managed-card-route">
        <strong>{pod.model}</strong>
        <span>{pod.providerAccountId}</span>
      </div>
      <div className="managed-card-metrics">
        <span>{pod.providerRequests.toLocaleString()} requests</span>
        <span>
          {pod.consumedTokens.toLocaleString()} observed tokens
          {pod.tokenUsageKnown ? '' : ' (incomplete)'}
        </span>
      </div>
      <div className="pod-card-meta">
        Attempt {pod.dispatcherAttemptId} · updated {formatDate(pod.lastEventAt)}
      </div>
    </Link>
  );
}

export function ManagedStateChip({ state }: { state: string }): JSX.Element {
  const normalized = state.replaceAll('_', ' ');
  let tone = 'neutral';
  if (['running', 'validating'].includes(state)) tone = 'progress';
  if (['validated', 'complete'].includes(state)) tone = 'ok';
  if (state === 'review_required') tone = 'warn';
  if (['failed', 'killed'].includes(state)) tone = 'danger';
  return <span className={`chip chip-${tone}`}>{normalized}</span>;
}

export function useManagedPodPolling(refresh: () => Promise<void>): void {
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
}

export function formatDate(seconds: number): string {
  return new Date(seconds * 1_000).toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
