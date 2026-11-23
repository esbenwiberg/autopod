import { AutopodError, type Pod } from '@autopod/shared';
import type { PodRepository } from './pod-repository.js';

/**
 * Task-run failure category for a worker turn the runtime proved unfinished
 * (`AgentErrorEvent.turnInterrupted`, #648): verified termination while the agent
 * was still working or waiting on background work. The daemon stopped it; it is
 * neither a provider nor an agent defect, so manual Rework is admitted like after
 * a completed turn, but nothing retries it automatically.
 */
export const TURN_INTERRUPTED_FAILURE_CATEGORY = 'turn_interrupted';

/** Wording the runtime puts in every interrupted-turn failure reason. */
const INTERRUPTED_TURN_REASON_MARKER = 'The turn is incomplete:';

/** Exact-resource ledger proof: this pod's latest settled run is an interrupted turn. */
function hasSettledInterruptedTurn(repo: Pick<PodRepository, 'taskExecutions'>, pod: Pod): boolean {
  const cycle = pod.finalization?.cycle;
  return (
    pod.status === 'failed' &&
    cycle !== undefined &&
    repo.taskExecutions?.hasSettledRun?.(pod, cycle, TURN_INTERRUPTED_FAILURE_CATEGORY) === true
  );
}

/** Routing check: ledger proof, or the recorded reason once the resource is gone. */
export function isInterruptedAgentTurn(
  repo: Pick<PodRepository, 'taskExecutions'>,
  pod: Pod,
): boolean {
  return (
    hasSettledInterruptedTurn(repo, pod) ||
    (pod.status === 'failed' &&
      pod.failureReason?.includes(INTERRUPTED_TURN_REASON_MARKER) === true)
  );
}

/** Checks-only recovery would validate unfinished coding as if the agent had finished. */
export function assertAgentTurnNotInterrupted(
  repo: Pick<PodRepository, 'taskExecutions'>,
  pod: Pod,
): void {
  if (isInterruptedAgentTurn(repo, pod))
    throw new AutopodError(
      `The agent's last turn was interrupted before it finished, so its work is incomplete. Run ap rework ${pod.id} to continue coding from the preserved worktree; Resume and Retry checks cannot finish an interrupted turn.`,
      'INTERRUPTED_TURN_REWORK_REQUIRED',
      409,
    );
}
