import type { AgentEvent, Pod } from '@autopod/shared';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ActionBar } from '../components/ActionBar.js';
import { ActivityList } from '../components/ActivityList.js';
import { EscalationCard } from '../components/EscalationCard.js';
import { SkipValidationToggle } from '../components/SkipValidationToggle.js';
import { StatusChip } from '../components/StatusChip.js';
import { ValidationSummary } from '../components/ValidationSummary.js';
import { ApiError, AuthRequiredError, apiFetch } from '../lib/api.js';
import { progressDetail, progressLabel, taskTitle } from '../lib/pod-display.js';
import { ACTIVITY_LIMIT, usePodsStore } from '../store/pods.js';

export function PodDetail(): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const pod = usePodsStore((s) => s.pods.find((p) => p.id === id));
  const activity = usePodsStore((s) => s.activity[id]) ?? [];
  const upsertPod = usePodsStore((s) => s.upsertPod);
  const trackActivity = usePodsStore((s) => s.trackActivity);
  const untrackActivity = usePodsStore((s) => s.untrackActivity);

  const [error, setError] = useState<string | null>(null);

  // Fetch the pod when it's not already in the store (deep-link case) so a
  // subsequent navigate-back shows it in the landing list. Also seed the
  // activity ring buffer.
  useEffect(() => {
    if (!id) return undefined;

    let cancelled = false;
    if (!pod) {
      apiFetch<Pod>(`/pods/${id}`)
        .then((p) => {
          if (!cancelled) upsertPod(p);
        })
        .catch((err) => {
          if (cancelled || err instanceof AuthRequiredError) return;
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
  }, [id, pod, upsertPod, trackActivity, untrackActivity]);

  if (error) {
    return (
      <main>
        <BackLink />
        <div className="error">{error}</div>
      </main>
    );
  }

  if (!pod) {
    return (
      <main>
        <BackLink />
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const data = pod;

  return (
    <main>
      <BackLink />
      <header className="detail-header">
        <div className="detail-id">{data.id}</div>
        <StatusChip status={data.status} />
      </header>
      <h1 className="detail-title">{taskTitle(data.task)}</h1>
      <p className="muted detail-meta">
        {data.profileName} · {data.runtime} · {data.model}
      </p>

      <ProgressPlan pod={data} />

      {data.pendingEscalation ? (
        <EscalationCard podId={data.id} escalation={data.pendingEscalation} />
      ) : null}

      {data.lastValidationResult ? <ValidationSummary result={data.lastValidationResult} /> : null}

      <ActionBar pod={data} />

      <SkipValidationToggle pod={data} />

      <details className="task-details">
        <summary>Full task</summary>
        <p>{data.task}</p>
      </details>

      <section className="activity-section">
        <h2>Recent activity</h2>
        <ActivityList events={activity} />
      </section>
    </main>
  );
}

function ProgressPlan({ pod }: { pod: Pod }): JSX.Element | null {
  const progress = progressLabel(pod);
  const detail = progressDetail(pod);
  const hasPlan = Boolean(pod.plan);
  if (!progress && !hasPlan) return null;

  return (
    <section className="info-panel">
      {progress ? (
        <div className="info-block">
          <div className="info-kicker">Progress</div>
          <div className="info-title">{progress}</div>
          {detail ? <div className="info-copy">{detail}</div> : null}
        </div>
      ) : null}
      {pod.plan ? (
        <div className="info-block">
          <div className="info-kicker">Plan</div>
          <div className="info-title">{pod.plan.summary}</div>
          {pod.plan.steps.length > 0 ? (
            <ol className="plan-steps">
              {pod.plan.steps.map((step, index) => (
                <li key={`${index}-${step}`}>{step.replace(/^\d+\.\s*/, '')}</li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function BackLink(): JSX.Element {
  return (
    <Link to="/" className="back-link">
      ← Back
    </Link>
  );
}
