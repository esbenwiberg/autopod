import { AutopodError, type Pod } from '@autopod/shared';
import { hasInterruptedArtifactCollection } from './artifact-finalization-recovery.js';

/** Suspension and a failed command are not proof that an old execution settled. */
export function assertValidationExecutionSettled(pod: Pod): void {
  const failure = pod.lastValidationResult?.infrastructureFailure;
  if (
    failure &&
    (['EXEC_EXIT_UNVERIFIED', 'CONTINUATION_OUTCOME_UNVERIFIED'].includes(failure.code) ||
      failure.execution?.cleanup === 'failed' ||
      failure.execution?.cleanup === 'unverified')
  )
    throw new AutopodError(
      'Validation execution termination is unverified. Retain source and reports; reconcile the original execution before retrying or starting a repair worker. A stopped sandbox is not proof of termination.',
      'VALIDATION_EXECUTION_UNVERIFIED',
      409,
    );
}

/** This action retries failed checks, not artifact collection, publication or merge. */
export function assertFailedValidationRecoverable(pod: Pod): void {
  if (
    !['failed', 'review_required'].includes(pod.status) ||
    pod.lastValidationResult?.overall !== 'fail'
  )
    throw new AutopodError(
      'Recovery requires a current failed validation result.',
      'INVALID_STATE',
      409,
    );
  if (
    pod.lastValidationResult?.factValidation?.status === 'pending_human' ||
    pod.lastValidationResult?.factValidation?.results.some(
      (fact) => fact.status === 'pending_human',
    )
  )
    throw new AutopodError(
      'Resolve the required fact decision before recovery.',
      'HUMAN_DECISION_PENDING',
      409,
    );
  if (pod.skipValidation)
    throw new AutopodError(
      'Validation bypass is enabled. Turn it off before requesting checks or repair.',
      'VALIDATION_BYPASSED',
      409,
    );
  if (pod.pendingEscalation)
    throw new AutopodError(
      'Resolve the pending human decision before recovery.',
      'HUMAN_DECISION_PENDING',
      409,
    );
  if (!pod.worktreePath || pod.worktreeCompromised)
    throw new AutopodError(
      'Restore the retained worktree before validation recovery.',
      'WORKTREE_COMPROMISED',
      409,
    );
  if (hasInterruptedArtifactCollection(pod))
    throw new AutopodError(
      'Use artifact collection recovery, not validation recovery.',
      'ARTIFACT_RECOVERY_REQUIRED',
      409,
    );
  assertValidationExecutionSettled(pod);
}
