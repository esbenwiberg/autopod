import type { TaskRetryStage, TaskRetryState } from '@autopod/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.js';

type Draft = { requestKey: string; reason: string };
export function TaskRetryPanel({
  podId,
  revision,
  status,
  stage = 'validation',
}: { podId: string; revision: string; status: string; stage?: TaskRetryStage }) {
  const [state, setState] = useState<TaskRetryState | null>(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const key = `autopod.retry-authorization.${podId}${stage === 'validation' ? '' : `.${stage}`}`;
  const statePath = `/pods/${podId}/retry-state${stage === 'validation' ? '' : `?stage=${stage}`}`;
  const label =
    stage === 'codex_interruption'
      ? 'Codex interruption recovery'
      : stage === 'validation'
        ? 'Validation'
        : 'Sandbox startup';
  // biome-ignore lint/correctness/useExhaustiveDependencies: Pod revisions and explicit refresh reload durable admission state.
  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError('');
    setMessage('');
    setPending(null);
    setReason('');
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Draft | null;
      if (value?.requestKey && value.reason) {
        setPending(value);
        setReason(value.reason);
      }
    } catch {
      setError('Saved retry draft is unreadable.');
    }
    apiFetch<TaskRetryState>(statePath)
      .then((value) => {
        if (!cancelled) setState(value);
      })
      .catch(() => {
        if (!cancelled) setError('Retry accounting unavailable.');
      });
    return () => {
      cancelled = true;
    };
  }, [podId, revision, refresh, key, statePath]);
  const record = async () => {
    setBusy(true);
    setError('');
    try {
      const draft = pending ?? { requestKey: crypto.randomUUID(), reason: reason.trim() };
      // Persist before sending so a lost response and reload use the same decision key.
      localStorage.setItem(key, JSON.stringify(draft));
      setPending(draft);
      await apiFetch(`/pods/${podId}/retry-authorizations`, {
        method: 'POST',
        body: JSON.stringify({ ...draft, ...(stage === 'validation' ? {} : { stage }) }),
      });
      localStorage.removeItem(key);
      setPending(null);
      setReason('');
      setState(await apiFetch<TaskRetryState>(statePath));
      setMessage('One retry authorization recorded. Resume is a separate action.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/pods/${podId}/resume`, { method: 'POST' });
      setState(await apiFetch<TaskRetryState>(statePath));
      setMessage(
        'Resume requested. Refresh to inspect whether execution was admitted and completed.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const failed =
    state?.latest?.outcome != null &&
    (state.latest.outcome !== 'pass' || stage === 'codex_interruption');
  const resumable = status === 'failed' || status === 'review_required';
  return (
    <section className="info-panel retry-panel">
      <h2>
        {stage === 'codex_interruption' ? 'Codex recovery allowance' : `${label} retry budget`}
      </h2>
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {state && (
        <>
          <p>
            {state.executedCount} executed / {state.admissionCount} admitted{' '}
            {stage === 'codex_interruption'
              ? 'Codex interruption recoveries'
              : stage === 'validation'
                ? 'validations'
                : 'sandbox startups'}{' '}
            across this task.
          </p>
          <p>
            {stage !== 'codex_interruption' &&
              `${state.transientRetryCount} / ${state.backoffsMs?.length ?? 0} automatic transient retries · `}
            {state.measuredDurationMs} ms measured · {state.interruptedCount} interrupted with
            unknown duration.
          </p>
          {stage === 'codex_interruption' && (
            <p>
              One automatic inner recovery per logical task; further recoveries require recorded
              human authorization. Duration overlaps the enclosing agent run; usage is not counted
              again.
            </p>
          )}
          <p>Latest outcome: {state.latest?.outcome ?? 'none'} · partial telemetry.</p>
          {state.authorizations.map((grant) => (
            <p key={grant.id}>
              {grant.usedByAttemptId
                ? 'Consumed'
                : grant.failureId === state.latest?.id
                  ? stage === 'codex_interruption'
                    ? 'Available for latest recovery'
                    : 'Available for latest failure'
                  : 'Superseded'}
              : {grant.reason}
            </p>
          ))}
          {failed && !resumable && (
            <p>
              Retry actions are available when this pod is failed or requires review. Pending human
              decisions remain separate.
            </p>
          )}
          {failed && resumable && (
            <>
              <label>
                Reason for one extra retry
                <textarea
                  value={reason}
                  disabled={busy || pending !== null}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={4000}
                />
              </label>
              <button type="button" disabled={busy || !reason.trim()} onClick={() => void record()}>
                {pending
                  ? 'Retry recording the same authorization'
                  : 'Record one retry authorization'}
              </button>
              <button type="button" disabled={busy} onClick={() => void resume()}>
                Resume{' '}
                {stage === 'codex_interruption'
                  ? 'task'
                  : stage === 'validation'
                    ? 'validation'
                    : 'sandbox startup'}
              </button>
            </>
          )}
        </>
      )}
      <button type="button" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        Refresh retry accounting
      </button>
    </section>
  );
}
