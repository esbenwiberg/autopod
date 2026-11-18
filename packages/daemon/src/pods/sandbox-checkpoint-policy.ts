import { AutopodError, type Pod } from '@autopod/shared';

type CheckpointSource = Pick<
  Pod,
  | 'executionTarget'
  | 'lifecycleGeneration'
  | 'startCommitSha'
  | 'status'
  | 'validationAttempts'
  | 'reworkCount'
  | 'recoveryCount'
  | 'lastValidationResult'
  | 'prUrl'
  | 'linkedPodId'
  | 'seriesId'
  | 'skipAgent'
  | 'options'
  | 'outputMode'
>;

/** Only the first coding segment's own, not-yet-validated source may be rewritten.
 * A prior capture remains in quarantine. Publication, repair/fix/series tasks and
 * later generations keep the ordinary strict ancestry requirement.
 */
export function unpublishedSandboxSourceBase(pod: CheckpointSource): string | undefined {
  if (
    pod.executionTarget !== 'sandbox' ||
    pod.lifecycleGeneration !== 1 ||
    !['running', 'failed'].includes(pod.status) ||
    pod.validationAttempts !== 0 ||
    pod.reworkCount !== 0 ||
    pod.recoveryCount !== 0 ||
    pod.lastValidationResult ||
    pod.prUrl ||
    pod.linkedPodId ||
    pod.seriesId ||
    pod.skipAgent ||
    pod.options.agentMode === 'interactive' ||
    !['pr', 'branch'].includes(pod.options.output ?? pod.outputMode) ||
    !pod.startCommitSha ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pod.startCommitSha)
  )
    return;
  return pod.startCommitSha;
}

/** Eligibility is captured authority, not a permission that survives a later
 * validation/publication or source change while capture awaits I/O.
 */
export function captureSandboxCheckpointAuthority(
  expected: CheckpointSource,
  guard: () => CheckpointSource,
): () => void {
  const base = unpublishedSandboxSourceBase(expected);
  return () => {
    const current = guard();
    if (base && unpublishedSandboxSourceBase(current) !== base) {
      throw new AutopodError(
        'Unpublished checkpoint source eligibility changed; original resources retained.',
        'STALE_CHECKPOINT_SOURCE',
        409,
      );
    }
  };
}
