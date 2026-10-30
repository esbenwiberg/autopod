import { AutopodError, type Pod, type ValidationInfrastructureFailure } from '@autopod/shared';
import type {
  ContainerManager,
  ContainerStartOptions,
  ExecOptions,
} from '../interfaces/container-manager.js';
import { hasInterruptedArtifactCollection } from './artifact-finalization-recovery.js';
import type { PodRepository } from './pod-repository.js';
import { captureValidationOwnership } from './validation-ownership.js';

/** No current ordinary-validation adapter supplies qualified final-content proof. */
export function assertValidationFinalContentSupported(): never {
  throw new AutopodError(
    'The provider cannot prove this exact validation execution is quiescent or preserve an immutable final source/report snapshot. Retain original resources; do not resume or delete them, or reuse an older export as final evidence.',
    'VALIDATION_FINAL_CONTENT_UNVERIFIED',
    409,
  );
}

/** Suspension and a failed command are not proof that an old execution settled. */
export function requiresValidationSettlement(pod: Pick<Pod, 'lastValidationResult'>): boolean {
  return requiresValidationFailureSettlement(pod.lastValidationResult?.infrastructureFailure);
}
export function requiresValidationFailureSettlement(
  failure: ValidationInfrastructureFailure | undefined,
): boolean {
  return (
    !!failure &&
    ([
      'EXEC_EXIT_UNVERIFIED',
      'CONTINUATION_OUTCOME_UNVERIFIED',
      'AZURE_SANDBOX_EXEC_INVALID_RESPONSE',
      'VALIDATION_ENGINE_TERMINATION_UNVERIFIED',
    ].includes(failure.code) ||
      failure.execution?.cleanup === 'failed' ||
      failure.execution?.cleanup === 'unverified')
  );
}
export function assertValidationExecutionSettled(pod: Pod, settled = false): void {
  if (requiresValidationSettlement(pod) && !settled)
    throw new AutopodError(
      `Validation execution termination is unverified. Inspect ap reconcile-validation ${pod.id} --json; retain original source and reports. The current provider cannot safely reconcile an unknown mutable execution; retry and repair remain blocked. A stopped sandbox is not termination proof.`,
      'VALIDATION_EXECUTION_UNVERIFIED',
      409,
    );
}

/** Independent of result overall, dismissals, waivers and recovery intents. */
export function assertValidationMutationSettled(
  repo: Pick<PodRepository, 'getOrThrow' | 'validationExecutions'>,
  podId: string,
): void {
  assertValidationExecutionSettled(repo.getOrThrow(podId));
  repo.validationExecutions?.assertTaskSettled(podId);
}

/** Recheck exact source ownership and task custody after every awaited preflight. */
export function captureValidationMutationGuard(
  repo: Pick<PodRepository, 'getOrThrow' | 'validationExecutions'>,
  pod: Pod,
): () => Pod {
  const ownership = captureValidationOwnership(pod, {
    statuses: [pod.status],
    readCurrent: () => repo.getOrThrow(pod.id),
    isCurrentInvocation: () => true,
    hasPendingDecision: () => false,
  });
  const assertCurrent = () => {
    assertValidationMutationSettled(repo, pod.id);
    return ownership.assertCurrent();
  };
  assertCurrent();
  return assertCurrent;
}

/** This action retries failed checks, not artifact collection, publication or merge. */
export function assertFailedValidationRecoverable(pod: Pod, settled = false): void {
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
  assertValidationExecutionSettled(pod, settled);
}

/** A bounded control's helper commands retain the same captured source authority. */
export function guardValidationContainer(
  manager: ContainerManager,
  assertCurrent: () => void,
): ContainerManager {
  const compose = (supplied?: () => void) => () => {
    assertCurrent();
    supplied?.();
  };
  const execInContainer: ContainerManager['execInContainer'] = (id, command, options) => {
    const guarded: ExecOptions = { ...options, assertCurrent: compose(options?.assertCurrent) };
    guarded.assertCurrent?.();
    return manager.execInContainer(id, command, guarded).then((result) => {
      assertCurrent();
      return result;
    });
  };
  const execStreaming: ContainerManager['execStreaming'] = (id, command, options) => {
    const guarded: ExecOptions = { ...options, assertCurrent: compose(options?.assertCurrent) };
    guarded.assertCurrent?.();
    // Return the owned handle even if authority changes after start. Its caller
    // must still be able to terminate and retain observed exit evidence.
    return manager.execStreaming(id, command, guarded);
  };
  const start: ContainerManager['start'] = (id, options) => {
    const guarded: ContainerStartOptions = {
      ...options,
      assertCurrent: compose(options?.assertCurrent),
    };
    guarded.assertCurrent?.();
    return manager.start(id, guarded).then(() => {
      assertCurrent();
    });
  };
  return new Proxy(manager, {
    get(target, key, receiver) {
      if (key === 'execInContainer') return execInContainer;
      if (key === 'execStreaming') return execStreaming;
      if (key === 'start') return start;
      // Exact-original cleanup is execution-owned, independent of caller custody.
      if (key === 'terminateRecordedExec') return target.terminateRecordedExec?.bind(target);
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertCurrent();
        const result = Reflect.apply(value, target, args);
        return result instanceof Promise
          ? result.then((value) => {
              assertCurrent();
              return value;
            })
          : result;
      };
    },
  });
}
