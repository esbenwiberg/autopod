import { createHash } from 'node:crypto';
import { AutopodError, type Pod, type TaskRetryOutcome } from '@autopod/shared';
import type { PodRepository } from '../pods/pod-repository.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownership = (pod: Pod) => ({
  generation: pod.lifecycleGeneration,
  containerId: pod.containerId,
  runtime: pod.runtime,
  model: pod.model,
  provider: pod.providerIdSnapshot,
  account: pod.providerAccountIdSnapshot,
  worktree: pod.worktreePath,
  target: pod.executionTarget,
});

/** A durable inner recovery admission, separate from the enclosing agent run and its usage. */
export function admitCodexRecovery(
  repo: PodRepository,
  podId: string,
  expected: Pod,
  containerId: string,
  sessionId: string,
  prompt: string,
) {
  const ledger = repo.codexInterruptionRetries;
  if (!ledger)
    throw new AutopodError(
      'Durable Codex recovery admission unavailable',
      'TASK_IDENTITY_UNAVAILABLE',
      409,
    );
  const captured = hash(ownership(expected));
  const assertCurrent = () => {
    const current = repo.getOrThrow(podId);
    if (
      current.status !== 'running' ||
      current.runtime !== 'codex' ||
      current.containerId !== containerId ||
      hash(ownership(current)) !== captured ||
      (current.codexSessionId !== null && current.codexSessionId !== sessionId) ||
      current.pendingEscalation ||
      repo.hasUnansweredDecision?.(podId)
    )
      throw new AutopodError(
        'Codex recovery ownership or human decision changed; recovery was not launched',
        'STALE_CODEX_RECOVERY',
        409,
      );
    const budget = repo.taskExecutions?.snapshot(podId).budgetCheck;
    if (budget?.status === 'exhausted' || budget?.status === 'unavailable')
      throw new AutopodError(budget.reason, 'TASK_BUDGET_UNAVAILABLE', 409);
  };
  assertCurrent();
  const admission = ledger.admit(
    podId,
    expected.lifecycleGeneration,
    {
      source: null,
      contract: expected.contract ? hash(expected.contract) : null,
      commands: hash(prompt),
      environment: null,
      implementation: hash('codex-interruption-recovery-v1'),
    },
    hash({
      runtime: expected.runtime,
      model: expected.model,
      provider: expected.providerIdSnapshot,
      account: expected.providerAccountIdSnapshot,
    }),
    [],
  );
  let started: number | undefined;
  return {
    beforeLaunch() {
      assertCurrent();
      ledger.start(admission.id);
      started = performance.now();
    },
    settle(outcome: TaskRetryOutcome) {
      ledger.finish(
        admission.id,
        started === undefined ? 'cancelled' : outcome,
        started === undefined ? null : Math.max(0, Math.round(performance.now() - started)),
      );
    },
  };
}
