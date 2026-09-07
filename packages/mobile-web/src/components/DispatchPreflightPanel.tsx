import type { CreatePodRequest, DispatchPreflightEvidence, Pod } from '@autopod/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../lib/api.js';

export function DispatchPreflightPanel({ pod }: { pod: Pod }) {
  const [evidence, setEvidence] = useState<DispatchPreflightEvidence | null>(null);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<CreatePodRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const key = `autopod.intentional-rerun.${pod.id}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload evidence when the pod changes.
  useEffect(() => {
    let cancelled = false;
    setEvidence(null);
    setError('');
    setPending(null);
    setReason('');
    setCreated(null);
    try {
      const draft = JSON.parse(localStorage.getItem(key) ?? 'null') as CreatePodRequest | null;
      if (draft?.intentionalRerun?.ofPodId === pod.id) {
        setPending(draft);
        setReason(draft.intentionalRerun.reason);
      }
    } catch {
      setError('Saved rerun request is unreadable.');
    }
    apiFetch<{ latest: DispatchPreflightEvidence | null }>(`/pods/${pod.id}/dispatch-preflight`)
      .then((value) => {
        if (!cancelled) setEvidence(value.latest);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pod.id, pod.updatedAt, key]);
  const rerun = async () => {
    setBusy(true);
    setError('');
    try {
      const draft: CreatePodRequest = pending ?? {
        ...(await apiFetch<CreatePodRequest>(`/pods/${pod.id}/rerun-template`)),
        intentionalRerun: {
          ofPodId: pod.id,
          reason: reason.trim(),
          requestKey: crypto.randomUUID(),
        },
      };
      // The full request is frozen before sending. A lost response never silently
      // creates a second task or incorporates subsequently edited source settings.
      localStorage.setItem(key, JSON.stringify(draft));
      setPending(draft);
      const result = await apiFetch<Pod>('/pods', { method: 'POST', body: JSON.stringify(draft) });
      localStorage.removeItem(key);
      setPending(null);
      setCreated(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="info-panel retry-panel">
      <h2>Dispatch preflight</h2>
      {error && <p role="alert">{error}</p>}
      {evidence ? (
        <>
          <p>
            {evidence.status} · {evidence.checkedAt}
          </p>
          <p>
            {evidence.repository} · {evidence.baseBranch}
          </p>
          <p>
            Fresh base: <code>{evidence.baseCommitSha}</code>
          </p>
          {evidence.conflicts.map((conflict) => (
            <p key={conflict.executionId}>
              Equivalent work: <Link to={`/pod/${conflict.podId}`}>{conflict.podId}</Link> ·{' '}
              {conflict.status} · {conflict.evidence}
            </p>
          ))}
          {evidence.rerun && (
            <p>
              Intentional rerun of {evidence.rerun.ofPodId}: {evidence.rerun.reason}
            </p>
          )}
        </>
      ) : (
        <p>No dispatch receipt available for this execution.</p>
      )}
      {created ? (
        <p>
          Distinct execution created: <Link to={`/pod/${created}`}>{created}</Link>. Its preflight
          and execution outcome remain separate.
        </p>
      ) : (
        pod.options.agentMode !== 'interactive' && (
          <>
            <p>
              To intentionally repeat this request, provide a reason. This creates a distinct task
              and may run a coding agent. Fresh contract, provider, and environment checks still
              apply.
            </p>
            <label>
              Reason for intentional rerun
              <textarea
                value={reason}
                maxLength={4000}
                disabled={busy || pending !== null}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button type="button" disabled={busy || !reason.trim()} onClick={() => void rerun()}>
              {pending ? 'Retry the same rerun request' : 'Create intentional rerun'}
            </button>
          </>
        )
      )}
    </section>
  );
}
