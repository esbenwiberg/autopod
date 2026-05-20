import { useEffect, useMemo, useState } from 'react';
import { PodCard } from '../components/PodCard.js';
import { byRecency, isActive, needsMe } from '../lib/pod-filters.js';
import { usePodsStore } from '../store/pods.js';

type Tab = 'needs-me' | 'active';

export function Landing(): JSX.Element {
  const { pods, loading, error, refresh } = usePodsStore();
  const [tab, setTab] = useState<Tab>('needs-me');

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const predicate = tab === 'needs-me' ? needsMe : isActive;
    return [...pods].filter(predicate).sort(byRecency);
  }, [pods, tab]);

  const needsMeCount = useMemo(() => pods.filter(needsMe).length, [pods]);

  return (
    <main>
      <header className="app-header">
        <h1>Autopod</h1>
        <button
          type="button"
          className="refresh-button"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh"
        >
          {loading ? '…' : '↻'}
        </button>
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
            {tab === 'needs-me' ? 'Nothing waiting on you. ☕' : 'No active pods.'}
          </p>
        ) : (
          filtered.map((pod) => <PodCard key={pod.id} pod={pod} />)
        )}
      </section>
    </main>
  );
}
