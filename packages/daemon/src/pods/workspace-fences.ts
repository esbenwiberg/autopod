import type { Pod } from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import { DeletionGuardError } from '../worktrees/local-worktree-manager.js';
import type { WorkspaceFencesCaptured } from './workspace-contracts.js';

export function createWorkspaceFences(captured: WorkspaceFencesCaptured) {
  const {
    podRepo,
    logger,
    eventBus,
    emitActivityStatus,
    nudgeRepo,
    emitActivityError,
    assertApprovalCurrent,
    assertGuidanceCollected,
    transition,
  } = captured;

  function handleDeletionGuardError(podId: string, err: unknown): boolean {
    if (!(err instanceof DeletionGuardError)) return false;
    try {
      podRepo.update(podId, { worktreeCompromised: true });
    } catch (updateErr) {
      logger.warn({ err: updateErr, podId }, 'Failed to persist worktreeCompromised flag');
    }
    eventBus.emit({
      type: 'pod.worktree_compromised',
      timestamp: new Date().toISOString(),
      podId,
      deletionCount: err.deletionCount,
      threshold: err.threshold,
    });
    emitActivityStatus(
      podId,
      `Worktree out of sync with container — ${err.deletionCount} phantom deletions blocked. Do not retry PR; work may still live in the container.`,
    );
    return true;
  }

  function ownsArtifactCompletion(
    pod: Pod,
    allowRemovedContainer = false,
    allowQueuedGuidance = false,
  ): boolean {
    const current = podRepo.getOrThrow(pod.id);
    return (
      current.lifecycleGeneration === pod.lifecycleGeneration &&
      (current.containerId === pod.containerId ||
        (allowRemovedContainer && current.containerId === null)) &&
      current.status === 'running' &&
      current.pendingEscalation === null &&
      (allowQueuedGuidance || !nudgeRepo.hasPending(pod.id))
    );
  }

  function failInteractivePreservation(pod: Pod, reason: string): never {
    const failureReason = `Workspace preservation failed. ${reason} Original resources retained; repair synchronization and retry completion.`;
    if (ownsArtifactCompletion(pod)) {
      podRepo.update(pod.id, { failureReason });
      emitActivityError(pod.id, failureReason, false);
    }
    throw new AutopodError(failureReason, 'WORKSPACE_PRESERVATION_FAILED', 502);
  }

  function failBranchPreservation(pod: Pod): never {
    assertApprovalCurrent(pod);
    const reason =
      'Branch preservation failed. Original resources retained; repair the branch or remote access and retry approval.';
    podRepo.update(pod.id, { failureReason: reason });
    emitActivityError(pod.id, reason, false);
    throw new AutopodError(reason, 'BRANCH_PRESERVATION_FAILED', 502);
  }

  function assertInteractiveCompletionCurrent(pod: Pod, allowRemovedContainer = false): void {
    assertGuidanceCollected(pod.id);
    const current = podRepo.getOrThrow(pod.id);
    if (
      current.lifecycleGeneration !== pod.lifecycleGeneration ||
      current.status !== 'running' ||
      current.options.agentMode !== 'interactive' ||
      current.options.output !== pod.options.output ||
      current.branch !== pod.branch ||
      current.baseBranch !== pod.baseBranch ||
      current.executionTarget !== pod.executionTarget ||
      current.worktreePath !== pod.worktreePath ||
      (current.containerId !== pod.containerId &&
        !(allowRemovedContainer && current.containerId === null))
    )
      throw new AutopodError(
        'Workspace completion was superseded; the current lifecycle and resources are retained.',
        'STALE_WORKSPACE_COMPLETION',
        409,
      );
    if (
      podRepo.hasUnansweredDecision?.(pod.id) ??
      Boolean(current.pendingEscalation || current.finalization?.pendingDecisionId)
    )
      throw new AutopodError(
        'An unanswered human decision must be resolved before completing this workspace.',
        'HUMAN_DECISION_PENDING',
        409,
      );
  }

  function parkOnWorktreeSyncFailure(podId: string, reason: string): void {
    try {
      podRepo.update(podId, { worktreeCompromised: true });
    } catch (updateErr) {
      logger.warn({ err: updateErr, podId }, 'Failed to persist worktreeCompromised flag');
    }
    emitActivityStatus(
      podId,
      `${reason} Recover the worktree before retrying validation or PR creation.`,
    );
    const current = podRepo.getOrThrow(podId);
    if (current.status === 'running' || current.status === 'validating') {
      transition(current, 'failed');
    }
  }
  return {
    handleDeletionGuardError,
    ownsArtifactCompletion,
    failInteractivePreservation,
    failBranchPreservation,
    assertInteractiveCompletionCurrent,
    parkOnWorktreeSyncFailure,
  };
}
