import type { Pod } from '@autopod/shared';
import { describeSyncFailure } from './completion-diagnostics.js';
import type { WorkspacePreservationRecoveryCaptured } from './workspace-contracts.js';

export function createWorkspacePreservationRecovery(
  captured: WorkspacePreservationRecoveryCaptured,
) {
  const {
    podRepo,
    preservePodWorkspace,
    cleanupContainer,
    emitActivityStatus,
    logger,
    containerManagerFactory,
    recoverWorktreeFromContainer,
  } = captured;

  async function preserveSandboxAfterAgentFailure(podId: string, reason: string): Promise<void> {
    const pod = podRepo.getOrThrow(podId);
    if (pod.executionTarget !== 'sandbox' || !pod.containerId || !pod.worktreePath) return;
    try {
      await preservePodWorkspace(pod, reason);
      await cleanupContainer(pod, 'agent-failure-preserved');
    } catch (preserveErr) {
      emitActivityStatus(
        podId,
        'Workspace preservation failed after the agent exit — retaining the sandbox and blocking destructive Rework.',
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
    if (!recovered) return false;

    podRepo.update(pod.id, { worktreeCompromised: false, preSubmitReview: null });
    emitActivityStatus(
      pod.id,
      `Workspace recovered from live container after sync failure; continuing ${phase}.`,
    );
    logger.info({ podId: pod.id, phase }, 'Recovered worktree after workspace sync failure');
    return true;
  }
  return { preserveSandboxAfterAgentFailure, tryRecoverAfterWorkspaceSyncFailure };
}
