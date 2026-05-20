import type { AgentEvent, Pod } from '@autopod/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ActivityList } from '../components/ActivityList.js';
import { StatusChip } from '../components/StatusChip.js';
import { ValidationSummary } from '../components/ValidationSummary.js';
import { ApiError, AuthRequiredError, apiFetch } from '../lib/api.js';
import { ACTIVITY_LIMIT, usePodsStore } from '../store/pods.js';

export function PodDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const pod = usePodsStore((s) => s.pods.find((p) => p.id === id));
  const activity = usePodsStore((s) => s.activity[id]) ?? [];
  const trackActivity = usePodsStore((s) => s.trackActivity);
  const untrackActivity = usePodsStore((s) => s.untrackActivity);

  const [fetched, setFetched] = useState<Pod | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = pod ?? fetched;

  // Fetch the pod row when it isn't already in the list store (deep-link case),
  // and seed the activity ring buffer from /pods/:id/events?limit=20.
  useEffect(() => {
    if (!id) return undefined;

    let cancelled = false;
    if (!pod) {
      apiFetch<Pod>(`/pods/${id}`)
        .then((p) => {
          if (!cancelled) setFetched(p);
        })
        .catch((err) => {
          if (cancelled) return;
          if (err instanceof AuthRequiredError) return;
          if (err instanceof ApiError) setError(err.message);
        });
    }

    apiFetch<AgentEvent[]>(`/pods/${id}/events?limit=${ACTIVITY_LIMIT}`)
      .then((events) => {
        if (!cancelled) trackActivity(id, events);
      })
      .catch(() => trackActivity(id, []));

    return () => {
      cancelled = true;
      untrackActivity(id);
    };
  }, [id, pod, trackActivity, untrackActivity]);

  if (!data) {
    return (
      <main>
        <BackLink />
        <p className="muted">{error ?? 'Loading…'}</p>
      </main>
    );
  }

  return (
    <main>
      <BackLink />
      <header className="detail-header">
        <div className="detail-id">{data.id}</div>
        <StatusChip status={data.status} />
      </header>
      <p className="detail-task">{data.task}</p>
      <p className="muted detail-meta">
        {data.profileName} · {data.runtime} · {data.model}
      </p>

      {data.lastValidationResult ? <ValidationSummary result={data.lastValidationResult} /> : null}

      <section className="activity-section">
        <h2>Recent activity</h2>
        <ActivityList events={activity} />
      </section>
    </main>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link to="/" className="back-link">
      ← Back
    </Link>
  );
}
