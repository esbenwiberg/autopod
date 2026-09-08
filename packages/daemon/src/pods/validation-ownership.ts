import { AutopodError, type Pod } from '@autopod/shared';

/** Superseded validation must not publish, park or release its replacement. */
export class ValidationSupersededError extends AutopodError {
  constructor() {
    super(
      'Validation execution was superseded; current work and decisions are retained.',
      'STALE_VALIDATION_EXECUTION',
      409,
    );
  }
}

export function captureValidationOwnership(
  expected: Pod,
  deps: {
    readCurrent(): Pod;
    isCurrentInvocation(): boolean;
    hasPendingDecision(): boolean;
  },
): { assertCurrent(): Pod; isCurrent(): boolean } {
  const identity = (pod: Pod) =>
    JSON.stringify([
      pod.lifecycleGeneration,
      pod.containerId,
      pod.executionTarget,
      pod.worktreePath,
      pod.branch,
      pod.baseBranch,
      pod.runtime,
      pod.model,
      pod.providerIdSnapshot,
      pod.providerAccountIdSnapshot,
      pod.profileSnapshot,
      pod.contract,
      pod.options,
    ]);
  const captured = identity(expected);
  const assertCurrent = (): Pod => {
    let current: Pod;
    try {
      current = deps.readCurrent();
    } catch {
      throw new ValidationSupersededError();
    }
    if (
      current.status !== 'validating' ||
      identity(current) !== captured ||
      !deps.isCurrentInvocation() ||
      deps.hasPendingDecision()
    )
      throw new ValidationSupersededError();
    return current;
  };
  return {
    assertCurrent,
    isCurrent() {
      try {
        assertCurrent();
        return true;
      } catch (err) {
        if (err instanceof ValidationSupersededError) return false;
        throw err;
      }
    },
  };
}
