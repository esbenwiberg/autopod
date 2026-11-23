import { type Pod, WORKSPACE_PRESERVATION_FAILED } from '@autopod/shared';
import type { PodRepository } from './pod-repository.js';

type RunLedgerRepo = Pick<PodRepository, 'taskExecutions'>;
type StagePod = Pick<Pod, 'id' | 'status' | 'lifecycleGeneration' | 'finalization'>;

/**
 * True when this failed pod's latest worker run in the current lifecycle ended
 * without completing (provider/quota/runtime failure, hand-off, interruption)
 * and the lifecycle never reached validation: unfinished coding (#670). This
 * also covers a cycle that already settled (`agentSettledAt`, e.g. a complete
 * event followed by a fatal error) — the settled journal alone does not prove
 * the worker finished. Validation-stage failures, and runs whose termination is
 * still unsettled, are not interrupted agent stages.
 */
export function isAgentStageInterrupted(repo: RunLedgerRepo, pod: StagePod): boolean {
  if (pod.status !== 'failed') return false;
  const run = repo.taskExecutions?.latestRun?.(pod.id, pod.lifecycleGeneration);
  if (!run?.endedAt || run.outcome === 'completed' || run.outcome === null) return false;
  if (pod.finalization?.generation === pod.lifecycleGeneration) {
    if (pod.finalization.cycle > run.cycle) return false;
    const phase = pod.finalization.phase;
    if (phase === 'finalizing' || phase === 'finished') return false;
  }
  return true;
}

/** Operator-facing workspace preservation state for refusal messages. */
export function describeSourceSavedState(pod: Pick<Pod, 'finalization' | 'failureReason'>): string {
  if (pod.finalization?.sourcePreservedAt)
    return `Source saved: ${pod.finalization.sourcePreservedAt}.`;
  if (pod.failureReason?.includes(WORKSPACE_PRESERVATION_FAILED))
    return 'Source NOT saved — the original container is retained; inspect ap status before Rework.';
  return 'Workspace preservation was not verified — inspect ap status before Rework.';
}
