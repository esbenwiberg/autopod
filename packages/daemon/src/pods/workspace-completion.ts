import { AutopodError } from '@autopod/shared';
import type {
  WorkspaceCompletionCalls,
  WorkspaceCompletionCaptured,
  WorkspaceCompletionLiveDependencies,
} from './workspace-contracts.js';

export function createWorkspaceCompletion(
  deps: WorkspaceCompletionLiveDependencies,
  captured: WorkspaceCompletionCaptured,
) {
  const {
    podRepo,
    coordinateInteractiveCompletion,
    assertInteractiveCompletionCurrent,
    preserveArtifacts,
    failInteractivePreservation,
    containerManagerFactory,
    syncWorkspaceBack,
    logger,
    executionForPod,
    runPushCheckpointScan,
    resolveGitCredential,
    worktreeManager,
    handleDeletionGuardError,
    emitActivityStatus,
    cleanupContainer,
    transition,
    eventBus,
  } = captured;

  async function completeSession(
    this: WorkspaceCompletionCalls,
    podId: string,
    options?: {
      promoteTo?: 'pr' | 'branch' | 'artifact' | 'none';
      instructions?: string;
      skipAgent?: boolean;
    },
  ): Promise<{ pushError?: string; promotedTo?: 'pr' | 'branch' | 'artifact' | 'none' }> {
    const pod = podRepo.getOrThrow(podId);
    return coordinateInteractiveCompletion(pod, options, async () => {
      if (pod.options.agentMode !== 'interactive') {
        throw new AutopodError(
          'Only interactive pods can be completed via this endpoint',
          'INVALID_OUTPUT_MODE',
          400,
        );
      }

      if (pod.status !== 'running') {
        throw new AutopodError(
          `Cannot complete pod in status '${pod.status}' — must be 'running'`,
          'INVALID_STATE',
          409,
        );
      }

      assertInteractiveCompletionCurrent(pod);

      // If caller asked us to promote (e.g. `ap complete <id> --pr`), hand off
      // into the agent-driven flow instead of just pushing + completing.
      if (options?.promoteTo && options.promoteTo !== 'branch') {
        await this.promoteToAuto(podId, options.promoteTo, {
          instructions: options.instructions,
          skipAgent: options.skipAgent,
        });
        return { promotedTo: options.promoteTo };
      }

      let pushError: string | undefined;

      if (pod.options.output === 'artifact') {
        // An interactive completion remains retryable if copying fails. No source
        // cleanup or terminal success can run before the snapshot is published.
        await preserveArtifacts(pod);
      } else {
        // Sync workspace changes back to host worktree before pushing
        if (pod.containerId && !pod.worktreePath && pod.options.output !== 'none')
          failInteractivePreservation(pod, 'The host worktree is unavailable.');
        if (pod.containerId && pod.worktreePath) {
          try {
            const cm = containerManagerFactory.get(pod.executionTarget);
            await syncWorkspaceBack(
              pod.containerId,
              pod.worktreePath,
              cm,
              podId,
              pod.executionTarget,
            );
          } catch (err) {
            logger.warn({ err, podId }, 'Failed to sync workspace before push');
            failInteractivePreservation(
              pod,
              'Neither workspace synchronization nor archive fallback succeeded.',
            );
          }
        }

        assertInteractiveCompletionCurrent(pod);

        // Push the branch to origin before completing, then clean up the worktree.
        // Only remove the worktree if push succeeds — don't lose uncommitted work.
        if (pod.worktreePath && pod.options.output !== 'none') {
          try {
            // Pre-push security scan for workspace-pod auto-push. The engine
            // rewrites block→escalate for workspace pods at the push checkpoint
            // so the human at the keyboard sees the warning rather than a hard
            // fail; runPushCheckpointScan only throws when block stays a block,
            // which happens for non-workspace pods (handled at validating entry).
            const pushScanProfile = executionForPod(pod);
            await runPushCheckpointScan(pod, pushScanProfile);
            assertInteractiveCompletionCurrent(pod);
            // Refuse to push a workspace pod directly to the default branch — this almost
            // always means the user passed `--branch main` by mistake. fixManually() pods
            // have linkedPodId set and are explicitly exempt.
            const completionBaseBranch = pod.baseBranch ?? pushScanProfile?.defaultBranch ?? 'main';
            if (!pod.linkedPodId && pod.branch === completionBaseBranch) {
              throw new AutopodError(
                `Refusing to push workspace pod directly to default branch '${pod.branch}'. Use ap complete <id> --pr or check out a feature branch first.`,
                'INVALID_STATE',
                409,
              );
            }
            // mergeBranch auto-commits any remaining uncommitted changes before pushing.
            // Sync-back must succeed before this point; retain the normal deletion guard.
            const rawTask = pod.task?.trim() ?? '';
            const commitMessage =
              rawTask.length > 0
                ? rawTask.length > 72
                  ? `${rawTask.slice(0, 69)}...`
                  : rawTask
                : 'chore: workspace session complete';
            const pushCredential = await resolveGitCredential(pushScanProfile);
            assertInteractiveCompletionCurrent(pod);
            await worktreeManager.mergeBranch({
              worktreePath: pod.worktreePath,
              targetBranch: pod.branch ?? 'HEAD',
              // Pass the PAT explicitly — workspace pods auto-push on container exit,
              // possibly hours/days after the worktree was created. The in-memory PAT
              // cache may be cold after a daemon restart in between.
              pat: pushCredential,
              maxDeletions: 100,
              commitMessage,
            });
            assertInteractiveCompletionCurrent(pod);
            logger.info({ podId, branch: pod.branch }, 'Workspace branch pushed to origin');
            // Safe to clean up — work is in origin
            try {
              await worktreeManager.cleanup(pod.worktreePath);
              logger.info({ podId }, 'Workspace worktree cleaned up');
            } catch (err) {
              logger.warn({ err, podId }, 'Failed to cleanup workspace worktree');
            }
          } catch (err) {
            assertInteractiveCompletionCurrent(pod);
            pushError = err instanceof Error ? err.message : String(err);
            logger.warn(
              { err, podId },
              'Failed to push workspace branch — completing anyway, worktree preserved',
            );
            handleDeletionGuardError(podId, err);
          }
        }
      }

      assertInteractiveCompletionCurrent(pod);
      emitActivityStatus(podId, 'Pod complete');
      await cleanupContainer(pod, 'workspace-complete', 'kill', () =>
        assertInteractiveCompletionCurrent(pod),
      );
      assertInteractiveCompletionCurrent(pod, true);
      const completingPod = podRepo.getOrThrow(podId);
      transition(completingPod, 'complete', {
        completedAt: new Date().toISOString(),
        ...(completingPod.failureReason?.startsWith('Workspace preservation failed.')
          ? { failureReason: null }
          : {}),
      });

      // Deactivate PIM groups on pod completion
      if (pod.pimGroups?.length && pod.userId) {
        try {
          const { createPimClient } = await import('../actions/handlers/azure-pim-handler.js');
          const pimClient = createPimClient(deps.getSecret, logger);
          for (const group of pod.pimGroups) {
            try {
              await pimClient.deactivate(group.groupId, pod.userId);
              logger.info({ podId, groupId: group.groupId }, 'PIM group deactivated');
            } catch (err) {
              logger.warn(
                { err, podId, groupId: group.groupId },
                'PIM deactivation failed — continuing',
              );
            }
          }
        } catch (err) {
          logger.warn({ err, podId }, 'Failed to load PIM client for deactivation');
        }
      }

      if (podRepo.getOrThrow(podId).lifecycleGeneration !== pod.lifecycleGeneration)
        return { pushError };
      eventBus.emit({
        type: 'pod.completed',
        timestamp: new Date().toISOString(),
        podId,
        finalStatus: 'complete',
        summary: {
          id: podId,
          profileName: pod.profileName,
          task: pod.task,
          status: 'complete',
          model: pod.model,
          runtime: pod.runtime,
          duration: pod.startedAt ? Date.now() - new Date(pod.startedAt).getTime() : null,
          filesChanged: pod.filesChanged,
          createdAt: pod.createdAt,
        },
      });

      // Auto-revalidate linked worker pod if this workspace was a fix
      if (pod.linkedPodId && !pushError) {
        try {
          const linked = podRepo.getOrThrow(pod.linkedPodId);
          if (linked.status === 'failed' || linked.status === 'review_required') {
            logger.info(
              { workspaceId: podId, workerId: pod.linkedPodId },
              'Workspace completed — auto-revalidating linked worker',
            );
            emitActivityStatus(
              pod.linkedPodId,
              `Linked workspace ${podId} completed — pulling changes and revalidating…`,
            );
            // Fire and forget — don't block workspace completion on revalidation
            this.revalidateSession(pod.linkedPodId).catch((err) => {
              logger.warn(
                { err, workspaceId: podId, workerId: pod.linkedPodId },
                'Auto-revalidation of linked worker failed',
              );
            });
          }
        } catch (err) {
          logger.warn(
            { err, podId, linkedPodId: pod.linkedPodId },
            'Failed to check linked pod for auto-revalidation',
          );
        }
      }

      logger.info({ podId, pushError }, 'Workspace pod completed');
      return { pushError };
    });
  }
  return { completeSession };
}
