import { createHash } from 'node:crypto';
import { AutopodError } from '@autopod/shared';
import { cleanupClaudeState } from '../runtimes/claude-state-store.js';
import { cleanupCodexState } from '../runtimes/codex-state-store.js';
import { runDeletionCleanup } from './deletion-cleanup.js';
import { deletionOwnershipError } from './deletion-ownership.js';
import { isTerminalState } from './state-machine.js';
import type { WorkspaceDeletionCaptured } from './workspace-contracts.js';

export function createWorkspaceDeletion(captured: WorkspaceDeletionCaptured) {
  const {
    podRepo,
    executionForPod,
    clearPreviewTimer,
    stopSandboxPreviewProxy,
    killSidecarsForPod,
    containerManagerFactory,
    destroyPodNetwork,
    cleanupTestRunBranches,
    worktreeManager,
    pendingUpdateFromBaseIntents,
    forceWithLeaseAllowances,
    logger,
  } = captured;

  async function deleteSession(podId: string): Promise<void> {
    podRepo.taskExecutions?.assertCanDelete(podId);
    podRepo.sourceAdoptions?.assertDeletable(podId);
    podRepo.externalDeliveries?.assertDeletable(podId);
    podRepo.sandboxWakeups?.assertPodReleasable(podId);
    const pod = podRepo.getOrThrow(podId);
    if (pod.containerId) {
      podRepo.sandboxWakeups?.assertReleasable(pod.containerId);
      podRepo.externalDeliveries?.assertReleasable(pod.containerId);
    }
    const deletable =
      isTerminalState(pod.status) ||
      pod.status === 'failed' ||
      pod.status === 'review_required' ||
      pod.status === 'killing';
    if (!deletable) {
      throw new AutopodError(
        `Cannot delete pod ${podId} in status ${pod.status} — kill it first`,
        'INVALID_STATE',
        409,
      );
    }
    const configuration = JSON.stringify(executionForPod(pod).testPipeline ?? null);
    const assertOwnership = () => {
      const current = podRepo.getOrThrow(podId);
      if (
        current.lifecycleGeneration !== pod.lifecycleGeneration ||
        current.status !== pod.status ||
        current.containerId !== pod.containerId ||
        current.executionTarget !== pod.executionTarget ||
        current.worktreePath !== pod.worktreePath ||
        current.runtime !== pod.runtime ||
        JSON.stringify(executionForPod(pod).testPipeline ?? null) !== configuration
      ) {
        throw new AutopodError(
          'Pod deletion cleanup ownership changed. Reconcile resource and pod state before retrying Delete.',
          'POD_DELETE_CLEANUP_UNVERIFIED',
          409,
        );
      }
      podRepo.taskExecutions?.assertCanDelete(podId);
      podRepo.sourceAdoptions?.assertDeletable(podId);
      podRepo.externalDeliveries?.assertDeletable(podId);
      podRepo.sandboxWakeups?.assertPodReleasable(podId);
      if (current.containerId) {
        podRepo.sandboxWakeups?.assertReleasable(current.containerId);
        podRepo.externalDeliveries?.assertReleasable(current.containerId);
      }
    };
    const claim = podRepo.deletionOwnership?.acquire(
      podId,
      createHash('sha256').update(configuration).digest('hex'),
    );
    if (!claim) throw deletionOwnershipError();
    const runtimeStateDirs: Partial<Record<string, (id: string) => Promise<void>>> = {
      claude: cleanupClaudeState,
      codex: cleanupCodexState,
    };
    await runDeletionCleanup(
      [
        {
          name: 'preview',
          run: async () => {
            clearPreviewTimer(podId);
            await stopSandboxPreviewProxy(podId);
          },
        },
        {
          name: 'sidecars',
          run: (assertCurrent) => killSidecarsForPod(podId, true, assertCurrent, true),
        },
        {
          name: 'container',
          run: async () => {
            if (pod.containerId)
              await containerManagerFactory.get(pod.executionTarget).kill(pod.containerId);
          },
        },
        { name: 'network', run: () => destroyPodNetwork(podId, true) },
        {
          name: 'test branches',
          run: (assertCurrent) =>
            cleanupTestRunBranches(podId, { strict: true, assertCurrent, retainMetadata: true }),
        },
        {
          name: 'worktree',
          run: async () => {
            if (pod.worktreePath) await worktreeManager.cleanup(pod.worktreePath);
          },
        },
        {
          name: 'runtime state',
          run: async () => {
            await runtimeStateDirs[pod.runtime]?.(podId);
          },
        },
      ],
      assertOwnership,
      25_000,
      claim,
    );
    assertOwnership();
    pendingUpdateFromBaseIntents.delete(podId);
    forceWithLeaseAllowances.delete(podId);
    claim.finish(() => podRepo.delete(podId));
    logger.info({ podId }, 'Pod deleted');
  }
  return { deleteSession };
}
