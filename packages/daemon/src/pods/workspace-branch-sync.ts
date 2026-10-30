import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AutopodError } from '@autopod/shared';
import { captureValidationMutationGuard } from './validation-recovery-policy.js';
import type { WorkspaceBranchSyncCaptured } from './workspace-contracts.js';
const execFileAsync = promisify(execFile);
export function createWorkspaceBranchSync(captured: WorkspaceBranchSyncCaptured) {
  const {
    podRepo,
    containerManagerFactory,
    syncWorkspaceBack,
    logger,
    executionForPod,
    worktreeManager,
    resolveGitCredential,
  } = captured;

  async function syncWorkspaceBranch(
    podId: string,
  ): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
    const pod = podRepo.getOrThrow(podId);
    const assertCurrent = captureValidationMutationGuard(podRepo, pod);
    const owned = async <T>(work: () => Promise<T>): Promise<T> => {
      assertCurrent();
      const value = await work();
      assertCurrent();
      return value;
    };

    if (pod.options.agentMode !== 'interactive') {
      throw new AutopodError(
        'sync-branch is only valid for interactive workspace pods',
        'INVALID_OUTPUT_MODE',
        400,
      );
    }
    if (pod.status !== 'running') {
      throw new AutopodError(
        `Cannot sync workspace branch in status '${pod.status}' — pod must be running`,
        'INVALID_STATE',
        409,
      );
    }
    if (!pod.worktreePath || !pod.branch) {
      throw new AutopodError(
        'Pod has no worktree or branch — nothing to sync',
        'INVALID_STATE',
        409,
      );
    }

    // Pull container changes back to the host worktree so any uncommitted
    // briefs the user just wrote land on disk. Mirrors the first step of
    // completeSession but stops short of pushing + cleaning up.
    if (pod.containerId) {
      try {
        const cm = containerManagerFactory.get(pod.executionTarget);
        await owned(async () =>
          syncWorkspaceBack(pod.containerId, pod.worktreePath, cm, podId, pod.executionTarget),
        );
      } catch (err) {
        logger.warn({ err, podId }, 'syncWorkspaceBranch: sync-back failed');
        return {
          committed: false,
          pushed: false,
          error:
            'Workspace synchronization failed; source resources are retained. Retry after repairing synchronization.',
        };
      }
    }

    // Publish authored handoff documents and contracts. Other staged code is
    // outside this operation; commitFiles commits only these explicit paths.
    const profile = executionForPod(pod);
    const headBefore = await worktreeManager
      .getCommitLog(pod.worktreePath, pod.branch, 1)
      .catch(() => '');
    try {
      // List each handoff document that differs from HEAD or is untracked. Using
      // `git ls-files` with the `--others`/`--modified` flags catches both
      // existing-but-edited briefs and brand-new ones in one pass.
      const { stdout: mdListed } = await owned(async () =>
        execFileAsync(
          'git',
          [
            'ls-files',
            '-z',
            '--modified',
            '--others',
            '--exclude-standard',
            '--',
            '*.md',
            'contract.yaml',
            'contract.yml',
            '**/contract.yaml',
            '**/contract.yml',
          ],
          { cwd: pod.worktreePath, maxBuffer: 10 * 1024 * 1024 },
        ),
      );
      const mdPaths = [...new Set(mdListed.split('\0').filter((p) => p.length > 0))];

      if (mdPaths.length === 0) {
        logger.info(
          { podId, branch: pod.branch },
          'syncWorkspaceBranch: no handoff document changes to commit',
        );
        await owned(async () =>
          worktreeManager.pushBranch(pod.worktreePath, pod.branch, {
            pat: await owned(async () => resolveGitCredential(profile)),
          }),
        );
        return { committed: false, pushed: true };
      }

      await owned(async () =>
        worktreeManager.commitFiles(
          pod.worktreePath,
          mdPaths,
          'chore: sync workspace for series handoff',
        ),
      );

      await owned(async () =>
        worktreeManager.pushBranch(pod.worktreePath, pod.branch, {
          pat: await owned(async () => resolveGitCredential(profile)),
        }),
      );

      const headAfter = await worktreeManager
        .getCommitLog(pod.worktreePath, pod.branch, 1)
        .catch(() => '');
      const committed = headBefore !== headAfter;
      logger.info(
        { podId, branch: pod.branch, committed, mdFiles: mdPaths.length },
        'syncWorkspaceBranch: briefs synced + pushed to origin',
      );
      return { committed, pushed: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, podId }, 'syncWorkspaceBranch: commit/push failed');
      return { committed: false, pushed: false, error: message };
    }
  }
  return { syncWorkspaceBranch };
}
