import { AutopodError, type Pod, WORKSPACE_PRESERVATION_FAILED } from '@autopod/shared';
import type { PodRepository } from './pod-repository.js';

type RunLedgerRepo = Pick<PodRepository, 'taskExecutions'>;

/**
 * True when this failed pod's latest worker run in the current lifecycle ended
 * without completing (provider/quota/runtime failure, hand-off, interruption)
 * and the lifecycle never reached validation: unfinished coding (#670).
 * Validation-stage failures, and runs whose termination is still unsettled,
 * are not interrupted agent stages.
 */
export function isAgentStageInterrupted(repo: RunLedgerRepo, pod: Pod): boolean {
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

/**
 * Validation-only Resume and push-only recovery would check or ship a partial
 * tree after an interrupted agent stage, so require a coding continuation.
 */
export function assertAgentStageNotInterrupted(repo: RunLedgerRepo, pod: Pod): void {
  if (!isAgentStageInterrupted(repo, pod)) return;
  const source = pod.finalization?.sourcePreservedAt
    ? `Source saved: ${pod.finalization.sourcePreservedAt}.`
    : pod.failureReason?.includes(WORKSPACE_PRESERVATION_FAILED)
      ? 'Source NOT saved — the original container is retained; inspect ap status before Rework.'
      : 'Workspace preservation was not verified — inspect ap status before Rework.';
  throw new AutopodError(
    `Pod ${pod.id} failed during the agent stage; validation-only Resume cannot finish unfinished work. Run: ap rework ${pod.id} (continue coding from the preserved workspace) or ap continue-provider ${pod.id} --primary (continue on the profile primary provider). ${source}`,
    'AGENT_STAGE_FAILED',
    409,
  );
}
