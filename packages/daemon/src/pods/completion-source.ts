import type { Pod } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { DeletionGuardError } from '../worktrees/local-worktree-manager.js';
import type { WorkspaceCheckpointResult } from '../worktrees/sandbox-workspace-checkpoint.js';
import type { PodRepository } from './pod-repository.js';

export interface CompletionSourcePreparation {
  sandboxCheckpoint?: WorkspaceCheckpointResult;
  sandboxCanonicalOutcome?: 'changed' | 'unchanged' | 'unavailable';
  sandboxHostProof?: { head: string; tree: string };
}

interface CompletionSourceDependencies {
  podRepo: Pick<PodRepository, 'getOrThrow' | 'update'>;
  getContainerManager(target: Pod['executionTarget']): ContainerManager;
  worktreeManager: Pick<
    WorktreeManager,
    'classifyCanonicalDiff' | 'commitPendingChangesWithGeneratedMessage' | 'getDiffStats'
  >;
  checkpointSandboxWorkspaceForPod(pod: Pod): Promise<WorkspaceCheckpointResult>;
  syncSandboxSeriesHandover(podId: string): Promise<void>;
  syncWorkspaceBack(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
    executionTarget: Pod['executionTarget'],
  ): Promise<{ pushed: boolean }>;
  tryRecoverAfterWorkspaceSyncFailure(
    pod: Pod,
    err: unknown,
    phase: 'auto-commit',
  ): Promise<boolean>;
  recoverWorktreeFromContainer(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
  ): Promise<boolean>;
  parkOnWorktreeSyncFailure(podId: string, reason: string): void;
  handleDeletionGuardError(podId: string, err: unknown): boolean;
  transition(pod: Pod, to: 'failed'): Pod;
  executionForPod(pod: Pod): PodExecutionSettings;
  emitActivityStatus(podId: string, message: string): void;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** Prepare source observations; the caller retains completion and validation decisions. */
export function createCompletionSource(deps: CompletionSourceDependencies): {
  prepareSourceForCompletion(pod: Pod): Promise<CompletionSourcePreparation | undefined>;
} {
  const {
    podRepo,
    getContainerManager,
    worktreeManager,
    checkpointSandboxWorkspaceForPod,
    syncSandboxSeriesHandover,
    syncWorkspaceBack,
    tryRecoverAfterWorkspaceSyncFailure,
    recoverWorktreeFromContainer,
    parkOnWorktreeSyncFailure,
    handleDeletionGuardError,
    transition,
    executionForPod,
    emitActivityStatus,
    logger,
  } = deps;

  async function prepareSourceForCompletion(
    pod: Pod,
  ): Promise<CompletionSourcePreparation | undefined> {
    const podId = pod.id;
    await syncSandboxSeriesHandover(podId);

    // Sync workspace back to host worktree before any host-side git reads
    // Sandboxes are deliberately different: a verified Git checkpoint is the
    // source-delivery authority. Never mirror /workspace into the host tree.
    let sandboxCheckpoint: WorkspaceCheckpointResult | undefined;
    if (pod.executionTarget === 'sandbox' && pod.containerId && pod.worktreePath) {
      emitActivityStatus(podId, 'Capturing verified sandbox workspace checkpoint…');
      const checkpoint = await checkpointSandboxWorkspaceForPod(pod);
      if (!checkpoint.promoted || !checkpoint.materialized || !checkpoint.lineageVerified) {
        emitActivityStatus(podId, 'Checkpoint transfer unavailable; retaining sandbox for retry.');
        parkOnWorktreeSyncFailure(
          podId,
          `Verified sandbox checkpoint failed: ${checkpoint.error?.message ?? 'incomplete proof'}`,
        );
        return;
      }
      emitActivityStatus(
        podId,
        `Verified sandbox checkpoint ${checkpoint.snapshotTree.slice(0, 12)} materialized.`,
      );
      sandboxCheckpoint = checkpoint;
    }
    let syncSucceeded = true;
    let agentCommitsPushed = true;
    if (pod.executionTarget !== 'sandbox' && pod.containerId && pod.worktreePath) {
      try {
        const cm = getContainerManager(pod.executionTarget);
        const result = await syncWorkspaceBack(
          pod.containerId,
          pod.worktreePath,
          cm,
          pod.id,
          pod.executionTarget,
        );
        agentCommitsPushed = result.pushed;
        if (!agentCommitsPushed) {
          logger.warn(
            { podId },
            'Sync-back completed but push to bare did not — auto-commit will run with strict deletion guard',
          );
        }
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to sync workspace back to host');
        const recovered = await tryRecoverAfterWorkspaceSyncFailure(pod, err, 'auto-commit');
        syncSucceeded = recovered;
        agentCommitsPushed = recovered;
      }
    }

    // Auto-commit any uncommitted changes the agent left behind, then get diff stats.
    // When sync failed OR the in-container push didn't land on the bare, clamp deletions
    // to 0 so a `git add -A` over a partially-synced or stale-base worktree can't masquerade
    // as agent work. Push failure here is the canary for /workspace/.git diverging from
    // the host bare's branch tip — see syncWorkspaceBack for context.
    const safeAutoCommit = syncSucceeded && agentCommitsPushed;
    if (!syncSucceeded) {
      parkOnWorktreeSyncFailure(
        podId,
        'Workspace sync failed before auto-commit — validation blocked.',
      );
      return;
    }
    let sandboxCanonicalOutcome: 'changed' | 'unchanged' | 'unavailable' | undefined;
    let sandboxHostProof: { head: string; tree: string } | undefined;
    if (pod.executionTarget === 'sandbox') {
      if (!pod.worktreePath || !pod.startCommitSha || !sandboxCheckpoint) {
        sandboxCanonicalOutcome = 'unavailable';
        logger.info(
          {
            podId,
            attempt: pod.validationAttempts,
            checkpointSequence: sandboxCheckpoint?.sequence ?? null,
            baseCommit: pod.startCommitSha?.slice(0, 12) ?? null,
            branch: pod.branch,
            outcome: sandboxCanonicalOutcome,
            code: !pod.startCommitSha ? 'BASE_UNAVAILABLE' : 'CHECKPOINT_UNAVAILABLE',
            lifecycleDecision: 'park_failed',
            cleanupSelected: false,
            validationSelected: false,
            prEligible: false,
          },
          'Sandbox finalization proof and decision',
        );
        parkOnWorktreeSyncFailure(
          podId,
          'Sandbox finalization proof is unavailable before change classification.',
        );
        return;
      }
      const classification = await worktreeManager.classifyCanonicalDiff(
        pod.worktreePath,
        pod.startCommitSha,
        sandboxCheckpoint.snapshotCommit,
        sandboxCheckpoint.snapshotTree,
      );
      sandboxCanonicalOutcome = classification.outcome;
      if (classification.outcome === 'unavailable') {
        logger.info(
          {
            podId,
            attempt: pod.validationAttempts,
            checkpointSequence: sandboxCheckpoint.sequence,
            baseCommit: pod.startCommitSha.slice(0, 12),
            branch: pod.branch,
            checkpointCommit: sandboxCheckpoint.snapshotCommit.slice(0, 12),
            checkpointTree: sandboxCheckpoint.snapshotTree.slice(0, 12),
            hostHead: classification.hostHead?.slice(0, 12) ?? null,
            hostTree: classification.hostTree?.slice(0, 12) ?? null,
            outcome: classification.outcome,
            code: classification.code,
            lifecycleDecision: 'park_failed',
            cleanupSelected: false,
            validationSelected: false,
            prEligible: false,
          },
          'Sandbox finalization proof and decision',
        );
        parkOnWorktreeSyncFailure(
          podId,
          `Sandbox finalization proof unavailable (${classification.code}).`,
        );
        return;
      }
      podRepo.update(podId, classification.stats);
      sandboxHostProof = { head: classification.hostHead, tree: classification.hostTree };
    } else if (pod.worktreePath) {
      const profileForCommit = executionForPod(pod);
      try {
        const committed = await worktreeManager.commitPendingChangesWithGeneratedMessage(
          pod.worktreePath,
          pod.task,
          profileForCommit,
          pod.model,
          { maxDeletions: safeAutoCommit ? 100 : 0 },
        );
        if (committed) {
          logger.info({ podId }, 'Auto-committed uncommitted agent changes');
        }
      } catch (err) {
        if (err instanceof DeletionGuardError && pod.containerId && pod.worktreePath) {
          logger.warn({ podId }, 'Deletion guard fired — attempting live container recovery');
          const cm = getContainerManager(pod.executionTarget);
          const recovered = await recoverWorktreeFromContainer(
            pod.containerId,
            pod.worktreePath,
            cm,
            pod.id,
          );
          if (recovered) {
            try {
              await worktreeManager.commitPendingChangesWithGeneratedMessage(
                pod.worktreePath,
                pod.task,
                profileForCommit,
                pod.model,
                { maxDeletions: 100 },
              );
              logger.info({ podId }, 'Auto-committed after live container recovery');
            } catch (retryErr) {
              logger.error({ err: retryErr, podId }, 'Commit after worktree recovery also failed');
              if (handleDeletionGuardError(podId, retryErr)) {
                const compromised = podRepo.getOrThrow(podId);
                if (compromised.status === 'running') {
                  transition(compromised, 'failed');
                }
                return;
              }
            }
          } else {
            logger.error({ err, podId }, 'Auto-commit blocked by deletion safety guard');
            if (handleDeletionGuardError(podId, err)) {
              const compromised = podRepo.getOrThrow(podId);
              if (compromised.status === 'running') {
                transition(compromised, 'failed');
              }
              return;
            }
          }
        } else {
          logger.error({ err, podId }, 'Auto-commit blocked by deletion safety guard');
          if (handleDeletionGuardError(podId, err)) {
            const compromised = podRepo.getOrThrow(podId);
            if (compromised.status === 'running') {
              transition(compromised, 'failed');
            }
            return;
          }
        }
      }

      try {
        const profile = executionForPod(pod);
        const defaultBranch = profile.defaultBranch ?? 'main';
        const sinceCommit = pod.startCommitSha ?? undefined;
        const baseBranchForStats = pod.baseBranch ?? defaultBranch;
        const stats = await worktreeManager.getDiffStats(
          pod.worktreePath,
          baseBranchForStats,
          sinceCommit,
        );
        podRepo.update(podId, {
          filesChanged: stats.filesChanged,
          linesAdded: stats.linesAdded,
          linesRemoved: stats.linesRemoved,
        });
      } catch (err) {
        logger.warn({ err, podId }, 'Failed to get diff stats');
      }
    }

    return { sandboxCheckpoint, sandboxCanonicalOutcome, sandboxHostProof };
  }

  return { prepareSourceForCompletion };
}
