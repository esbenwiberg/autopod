import type { JSX } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PodCard } from '../components/PodCard.js';
import { byRecency, isActive, needsMe } from '../lib/pod-filters.js';
import { usePodsStore } from '../store/pods.js';

type Tab = 'needs-me' | 'active';

export function Landing(): JSX.Element {
  // Per-slice subscriptions — zustand v5 requires this for fine-grained
  // re-renders. Destructuring the whole store re-renders on every set().
  const pods = usePodsStore((s) => s.pods);
  const loading = usePodsStore((s) => s.loading);
  const error = usePodsStore((s) => s.error);
  const connected = usePodsStore((s) => s.connected);
  const refresh = usePodsStore((s) => s.refresh);
  const [tab, setTab] = useState<Tab>('needs-me');

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const predicate = tab === 'needs-me' ? needsMe : isActive;
    // .filter() returns a new array, so .sort() doesn't mutate `pods`.
    return pods.filter(predicate).sort(byRecency);
  }, [pods, tab]);

  const needsMeCount = useMemo(() => pods.filter(needsMe).length, [pods]);

  return (
    <main>
      <header className="app-header">
        <h1>Autopod</h1>
        <div className="header-actions">
          <Link
            to="/create"
            className="action-btn action-primary header-create"
            aria-label="New pod"
          >
            + New
          </Link>
          <button
            type="button"
            className="refresh-button"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label={connected ? 'Live — tap to force refresh' : 'Disconnected — tap to retry'}
            title={connected ? 'live' : 'reconnecting…'}
          >
            <span
              className={connected ? 'conn-dot conn-dot-live' : 'conn-dot conn-dot-offline'}
              aria-hidden="true"
            />
            {loading ? '…' : '↻'}
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={tab === 'needs-me' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('needs-me')}
        >
          Needs me
          {needsMeCount > 0 ? <span className="tab-badge">{needsMeCount}</span> : null}
        </button>
        <button
          type="button"
          className={tab === 'active' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('active')}
        >
          Active
        </button>
      </nav>

      {error ? <div className="error">{error}</div> : null}

      <section className="pod-list">
        {filtered.length === 0 && !loading ? (
          <p className="empty">
            {tab === 'needs-me' ? 'Nothing waiting on you.' : 'No active pods.'}
          </p>
        ) : (
          filtered.map((pod) => <PodCard key={pod.id} pod={pod} />)
        )}
      </section>

      <footer className="app-footer">
        <Link to="/about" className="muted footer-link">
          About
        </Link>
      </footer>
    </main>
  );
}
