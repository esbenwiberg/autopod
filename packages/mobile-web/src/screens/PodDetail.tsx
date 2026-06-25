import type { AgentEvent, Pod } from '@autopod/shared';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ActionBar } from '../components/ActionBar.js';
import { ActivityList } from '../components/ActivityList.js';
import { EscalationCard } from '../components/EscalationCard.js';
import { SkipValidationToggle } from '../components/SkipValidationToggle.js';
import { StatusChip } from '../components/StatusChip.js';
import { TaskMarkdownCards } from '../components/TaskMarkdownCards.js';
import { type StoredValidation, ValidationSummary } from '../components/ValidationSummary.js';
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
  const [validationHistory, setValidationHistory] = useState<StoredValidation[]>([]);

  // Fetch the pod when it's not already in the store (deep-link case) so a
  // subsequent navigate-back shows it in the landing list.
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

    return () => {
      cancelled = true;
    };
  }, [id, pod, upsertPod]);

  // Seed replayable detail data when the selected pod changes.
  useEffect(() => {
    if (!id) return undefined;

    let cancelled = false;
    setValidationHistory([]);

    apiFetch<AgentEvent[]>(`/pods/${id}/events?limit=${ACTIVITY_LIMIT}`)
      .then((events) => {
        if (!cancelled) trackActivity(id, events);
      })
      .catch(() => trackActivity(id, []));

    apiFetch<StoredValidation[]>(`/pods/${id}/validations`)
      .then((history) => {
        if (!cancelled) setValidationHistory(history);
      })
      .catch(() => {
        if (!cancelled) setValidationHistory([]);
      });

    return () => {
      cancelled = true;
      untrackActivity(id);
    };
  }, [id, trackActivity, untrackActivity]);

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

      <ValidationSummary result={data.lastValidationResult} history={validationHistory} />

      <ActionBar pod={data} />

      <SkipValidationToggle pod={data} />

      <TaskMarkdownCards markdown={data.task} />

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
          <div className="info-header">
            <div className="info-kicker">Progress</div>
            <span className="info-count">
              {pod.progress?.currentPhase ?? 0} of {Math.max(pod.progress?.totalPhases ?? 1, 1)}
            </span>
          </div>
          <div className="progress-track" aria-hidden="true">
            <div className="progress-fill" style={{ width: progressWidth(pod) }} />
          </div>
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

function progressWidth(pod: Pod): string {
  const total = Math.max(pod.progress?.totalPhases ?? 1, 1);
  const current = Math.min(Math.max(pod.progress?.currentPhase ?? 0, 0), total);
  return `${Math.round((current / total) * 100)}%`;
}

function BackLink(): JSX.Element {
  return (
    <Link to="/" className="back-link">
      ← Back
    </Link>
  );
}
