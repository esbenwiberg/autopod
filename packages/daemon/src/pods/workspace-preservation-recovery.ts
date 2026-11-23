import type { Pod } from '@autopod/shared';
import { describeSyncFailure } from './completion-diagnostics.js';
import {
  assertValidationMutationSettled,
  captureValidationMutationGuard,
} from './validation-recovery-policy.js';
import type { WorkspacePreservationRecoveryCaptured } from './workspace-contracts.js';
import {
  recordWorkspacePreservationFailure,
  recordWorkspacePreserved,
} from './workspace-preservation-outcome.js';

export function createWorkspacePreservationRecovery(
  captured: WorkspacePreservationRecoveryCaptured,
) {
  const {
    podRepo,
    preservePodWorkspace,
    emitActivityStatus,
    logger,
    containerManagerFactory,
    recoverWorktreeFromContainer,
  } = captured;

  /**
   * Copy an abnormally-ended worker's container workspace (uncommitted and
   * untracked source) into the host worktree before anything can remove the
   * container. Sandboxes use their verified checkpoint; local Docker uses the
   * ordinary bounded sync-back (archive fallback covers a stopped container).
   * Success records `Source saved`; failure is recorded on the pod and the
   * container is always retained as the only copy.
   */
  async function preserveWorkspaceAfterAgentFailure(podId: string, reason: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (
      (pod.executionTarget !== 'sandbox' && pod.executionTarget !== 'local') ||
      !pod.containerId ||
      !pod.worktreePath
    )
      return;
    // Never wake a failed/unsettled execution just to collect a checkpoint.
    if (podRepo.taskExecutions?.hasActiveRun(podId)) return;
    try {
      assertValidationMutationSettled(podRepo, podId);
      const status = await containerManagerFactory
        .get(pod.executionTarget)
        .getStatus(pod.containerId);
      const current = podRepo.getOrThrow(podId);
      if (
        current.lifecycleGeneration !== pod.lifecycleGeneration ||
        current.containerId !== pod.containerId ||
        current.status !== pod.status ||
        podRepo.taskExecutions?.hasActiveRun(podId)
      )
        return;
      if (pod.executionTarget === 'sandbox' && status !== 'running') return;
      if (pod.executionTarget === 'local') {
        if (status === 'deleted') {
          emitActivityStatus(
            podId,
            'Worker container no longer exists — uncommitted changes from the failed run could not be preserved. Rework continues from the host worktree.',
          );
          return;
        }
        if (status === 'unknown') throw new Error(`Container ${pod.containerId} status is unknown`);
      }
      assertValidationMutationSettled(podRepo, podId);
      await preservePodWorkspace(current, reason);
      recordWorkspacePreserved(podRepo, current);
      // A tracked-source checkpoint does not prove ignored report preservation.
      // Leave the original source intact until a dedicated capture/release workflow.
      logger.info(
        { podId, containerId: pod.containerId, executionTarget: pod.executionTarget },
        'Workspace preserved after agent failure; original container retained',
      );
    } catch (preserveErr) {
      const current = podRepo.getOrThrow(podId);
      if (
        current.lifecycleGeneration === pod.lifecycleGeneration &&
        current.containerId === pod.containerId
      )
        recordWorkspacePreservationFailure(podRepo, podId, preserveErr);
      emitActivityStatus(
        podId,
        `Workspace preservation failed after the agent exit — retaining the ${pod.executionTarget === 'sandbox' ? 'sandbox' : 'container'} and blocking destructive Rework.`,
      );
      logger.error(
        { err: preserveErr, podId, containerId: pod.containerId },
        'Failed to preserve workspace after agent failure',
      );
    }
  }

  async function tryRecoverAfterWorkspaceSyncFailure(
    pod: Pod,
    err: unknown,
    phase: 'auto-commit' | 'validation',
  ): Promise<boolean> {
    const assertCurrent = captureValidationMutationGuard(podRepo, pod);
    if (!pod.containerId || !pod.worktreePath) return false;

    const detail = describeSyncFailure(err);
    logger.warn(
      { err, podId: pod.id, phase },
      'Workspace sync failed - attempting live container recovery',
    );
    emitActivityStatus(
      pod.id,
      `Workspace sync failed before ${phase} (${detail}). Attempting live container recovery...`,
    );

    const cm = containerManagerFactory.get(pod.executionTarget);
    const recovered = await recoverWorktreeFromContainer(
      pod.containerId,
      pod.worktreePath,
      cm,
      pod.id,
    );
    assertCurrent();
    if (!recovered) return false;

    podRepo.update(pod.id, { worktreeCompromised: false, preSubmitReview: null });
    emitActivityStatus(
      pod.id,
      `Workspace recovered from live container after sync failure; continuing ${phase}.`,
    );
    logger.info({ podId: pod.id, phase }, 'Recovered worktree after workspace sync failure');
    return true;
  }
  return { preserveWorkspaceAfterAgentFailure, tryRecoverAfterWorkspaceSyncFailure };
}
