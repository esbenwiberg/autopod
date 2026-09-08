import type { TaskExecutionSummary } from '@autopod/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api.js';

export function TaskExecutionPanel({ podId, revision }: { podId: string; revision: string }) {
  const [data, setData] = useState<TaskExecutionSummary | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh clicks and pod revisions intentionally reload the projection.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setUnavailable(false);
    apiFetch<TaskExecutionSummary>(`/pods/${podId}/task-execution`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, [podId, revision, refresh]);
  return (
    <section className="info-panel">
      <h2>Task accounting</h2>
      {data ? (
        <>
          <p>Logical task: {data.taskId}</p>
          <p>Execution: {data.executionId}</p>
          <p>
            {data.podCount} pods · {data.agentRunCount} recorded agent runs ·{' '}
            {data.providerAttemptCount} provider attempts · {data.validationExecutionCount}{' '}
            validations
          </p>
          <p>
            {data.delivery
              ? `${data.delivery.receiptCount} PR receipts · ${data.delivery.unresolvedCount} unresolved of ${data.delivery.intentCount} intents`
              : 'PR receipts unavailable.'}
          </p>
          {data.delivery && (
            <p className="muted">
              Durable ledger only; historical PR URLs are not reconstructed receipts.
            </p>
          )}
          <p>
            {data.delivery?.disposition
              ? `Last recorded PR status: ${data.delivery.disposition.openCount} open · ${data.delivery.disposition.mergedCount} merged · ${data.delivery.disposition.closedCount} closed · ${data.delivery.disposition.unavailableCount} unavailable`
              : 'PR disposition observations unavailable.'}
          </p>
          {data.merge ? (
            <>
              <p>
                Source-bound merges: {data.merge.mergedPrCount} merged PRs ·{' '}
                {data.merge.requestCount} recorded requests · {data.merge.unresolvedPrCount}{' '}
                unresolved of {data.merge.prCount} PRs
              </p>
              <p>
                {data.merge.mergedWithoutRecordedRequestCount} merged PRs observed with no recorded
                request; merge actor is not inferred.
              </p>
              <p className="muted">Source-bound journal only; historical PR URLs excluded.</p>
            </>
          ) : (
            <p>Source-bound merge evidence unavailable.</p>
          )}
          <p className="muted">Current provider status unverified.</p>
          <p>
            Recorded tokens: {data.recordedInputTokens + data.recordedOutputTokens} /{' '}
            {data.tokenBudget ?? 'no configured limit'}
          </p>
          <p>
            Stored task cost subtotal: ${data.recordedCostUsd.toFixed(4)} · {data.telemetry}{' '}
            telemetry
          </p>
          <p className="muted">Billing unverified; stored amounts can include estimates.</p>
          {data.costEvidence ? (
            <>
              <p>
                Known estimates: ${data.costEvidence.knownEstimatedCostUsd.toFixed(4)} ·{' '}
                {data.costEvidence.unavailablePhaseCount} identified phases with unavailable cost ·{' '}
                {data.costEvidence.conflictingPodCount} pods with conflicting attribution
              </p>
              {data.costEvidence.diagnostics.map((item, index) => (
                <p key={`${item.podId}:${item.code}:${index}`} className="muted">
                  {item.podId}: {item.message}
                </p>
              ))}
              {data.costEvidence.omittedDiagnosticCount > 0 && (
                <p>
                  {data.costEvidence.omittedDiagnosticCount} additional cost diagnostics omitted.
                </p>
              )}
            </>
          ) : (
            <p className="muted">Cost provenance unavailable.</p>
          )}
          <p>{data.budgetCheck?.reason ?? 'Task budget admission evidence unavailable.'}</p>
          {data.diagnostics.map((message) => (
            <p key={message} className="muted">
              {message}
            </p>
          ))}
        </>
      ) : (
        <p>{unavailable ? 'Task accounting unavailable.' : 'Loading task accounting…'}</p>
      )}
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>
        Refresh task accounting
      </button>
    </section>
  );
}
