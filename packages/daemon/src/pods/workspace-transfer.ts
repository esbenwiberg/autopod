import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionTarget } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/index.js';
import { deriveBareRepoPath, pushCommitsToBareViaStagingRef } from '../worktrees/bare-push.js';
import {
  WORKSPACE_SYNC_EXCLUDES,
  buildWorkspaceMirrorCopyScript,
  workspaceMirrorPreservePredicates,
  workspaceMirrorPruneExpression,
} from './workspace-mirror.js';

const execFileAsync = promisify(execFile);

export interface WorkspaceTransferDependencies {
  logger: Pick<Logger, 'info' | 'warn'>;
}

/**
 * Poll `cm.getStatus(containerId)` until the engine reports `running`, the
 * container is definitively `stopped`, or the budget runs out. Returns
 * `'ready'` when the container is back, `'gone'` if the engine is reachable
 * but the container is gone, `'timeout'` if the budget expired before either
 * outcome. Never throws — engine-unreachable errors are treated as "still
 * stalled, keep polling."
 */
export async function waitForContainerReachable(
  containerId: string,
  cm: ContainerManager,
  maxWaitMs: number,
): Promise<'ready' | 'gone' | 'timeout'> {
  const start = Date.now();
  const probeIntervalMs = 2_000;
  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await cm.getStatus(containerId);
      if (status === 'running') return 'ready';
      if (status === 'stopped' || status === 'deleted') return 'gone';
      // 'unknown' → keep polling, engine may still be coming back.
    } catch {
      // Engine still unreachable — that's exactly the case we wait through.
    }
    await new Promise((resolve) => setTimeout(resolve, probeIntervalMs));
  }
  return 'timeout';
}

export function createWorkspaceTransfer(deps: WorkspaceTransferDependencies) {
  const { logger } = deps;

  /**
   * True when an error looks like a Docker engine stall — the kind that
   * resolves itself once the Docker Desktop VM finishes resuming after the
   * host's laptop sleep. We retry on these. Domain errors (e.g. `rm: cannot
   * remove`, non-zero git exit) bubble out unretried.
   */
  function looksLikeEngineStall(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = `${err.message}`.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('epipe') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('connect enoent') || // unix socket missing while VM is paused
      msg.includes('eai_again') ||
      // Dockerode rethrows engine 5xx as plain Error with these substrings.
      msg.includes('server error') ||
      msg.includes('502 bad gateway')
    );
  }

  /**
   * Run a sync-back operation, retrying past Docker-engine stalls. Each retry
   * waits for the engine + container to come back before re-issuing the op,
   * up to a hard cap so a wedged engine can't hang the pod cleanup forever.
   *
   * Why retry: laptop sleep → Docker Desktop pauses → in-flight `cm.exec` /
   * `getArchive` calls fail with transient socket errors. Without retry, the
   * one-shot sync command leaves the host worktree partially populated (the
   * `find … rm` half ran, `cp -a` got killed) → next auto-commit trips the
   * deletion guard → operator sees "Worktree out of sync with container."
   * The whole sync is idempotent (rm is no-op on missing, cp re-copies, git
   * push is fast-forward or no-op), so re-running on the same container is
   * safe.
   */
  async function withEngineStallRetry<T>(
    containerId: string,
    cm: ContainerManager,
    op: () => Promise<T>,
    label: string,
  ): Promise<T> {
    const backoffsMs = [5_000, 15_000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
      if (attempt > 0) {
        const waitBudget = backoffsMs[attempt - 1] ?? 15_000;
        logger.warn(
          { containerId, attempt, waitBudget, label },
          'Engine stall detected — waiting for container to come back before retry',
        );
        const result = await waitForContainerReachable(containerId, cm, waitBudget);
        if (result === 'gone') {
          // Container is definitively stopped — no point retrying the op.
          throw lastErr ?? new Error(`${label}: container stopped during retry wait`);
        }
        // 'ready' or 'timeout' → either way we try the op once more; if the
        // engine is still wedged, the next throw will end the loop.
      }
      try {
        return await op();
      } catch (err) {
        if (!looksLikeEngineStall(err)) {
          // Domain error — rethrow without retry so callers handle it.
          throw err;
        }
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`${label}: retries exhausted`);
  }

  /**
   * Copy workspace changes from container back to the host worktree (bind mount).
   * The worktree is bind-mounted at /mnt/worktree while the agent works on the
   * container's native /workspace (overlayfs) — this avoids VirtioFS getcwd() bugs
   * on Docker Desktop for Mac. We sync back before any host-side git operations.
   *
   * Strategy:
   *  1. Read the bare repo path from /workspace/.git/objects/info/alternates (written by the
   *     gitlink→real-dir conversion at container start).
   *  2. Push new commits from /workspace to the bare so host git sees them after sync.
   *  3. Sync files back excluding git/dependency/tooling caches — the host worktree's
   *     gitlink is preserved and platform-native dependency trees stay on their own OS.
   *
   * If the container is already stopped, falls back to Docker's archive API. In that case
   * we extract /workspace (minus .git) then extract /workspace/.git separately and push
   * from the host side.
   *
   * The whole flow is wrapped in `withEngineStallRetry` so a Docker Desktop
   * VM pause (typically: laptop sleep) won't leave the host worktree
   * partially populated — see that helper for the rationale.
   */
  async function syncWorkspaceBack(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
    executionTarget: ExecutionTarget = 'local',
  ): Promise<{ pushed: boolean }> {
    return withEngineStallRetry(
      containerId,
      cm,
      () => syncWorkspaceBackOnce(containerId, worktreePath, cm, podId, executionTarget),
      'syncWorkspaceBack',
    );
  }

  async function syncWorkspaceBackOnce(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
    executionTarget: ExecutionTarget,
  ): Promise<{ pushed: boolean }> {
    let pushed = false;
    if (executionTarget === 'sandbox') {
      return extractWorkspaceBackAndRecoverGit(containerId, worktreePath, cm, podId);
    }
    try {
      // Read the bare repo path from the alternates file written during gitlink conversion.
      // Alternates contains "<bareRepoPath>/objects" — strip the trailing "/objects".
      const alternatesResult = await cm.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          "sed 's|/objects$||' /workspace/.git/objects/info/alternates 2>/dev/null | head -1 || true",
        ],
        { timeout: 5_000 },
      );
      const bareRepoPath =
        alternatesResult.exitCode === 0 && alternatesResult.stdout.trim()
          ? alternatesResult.stdout.trim()
          : null;

      // Push new commits to the bare before clearing the bind mount, so any commits made
      // inside the container are visible to host-side git operations after sync.
      if (bareRepoPath) {
        // Validate the container-supplied path against the daemon-derived path to
        // prevent an adversarial agent from injecting a different remote via the alternates file.
        let expectedBareRepoPath: string | null = null;
        try {
          expectedBareRepoPath = await deriveBareRepoPath(worktreePath);
        } catch {
          // If we can't derive the expected path, skip the push (fail safe).
        }
        if (!expectedBareRepoPath || bareRepoPath !== expectedBareRepoPath) {
          logger.warn(
            { worktreePath, bareRepoPath, expectedBareRepoPath },
            'Bare repo path from container does not match daemon-derived path — skipping in-container push',
          );
        } else {
          for (const safeDirectory of ['/workspace', bareRepoPath]) {
            const safeDirectoryResult = await cm.execInContainer(
              containerId,
              ['git', 'config', '--global', '--add', 'safe.directory', safeDirectory],
              { timeout: 5_000 },
            );
            if (safeDirectoryResult.exitCode !== 0) {
              logger.warn(
                {
                  podId,
                  safeDirectory,
                  stderr: safeDirectoryResult.stderr.slice(0, 500),
                },
                'Failed to persist git safe.directory before sync-back push',
              );
            }
          }

          // Push via per-pod staging ref then promote — a direct push to refs/heads/<branch>
          // is refused by the bare's `receive.denyCurrentBranch` because the host worktree
          // (a linked worktree of the bare) has that branch checked out.
          const result = await pushCommitsToBareViaStagingRef(
            async (args) => {
              const r = await cm.execInContainer(
                containerId,
                [
                  'git',
                  '-c',
                  'safe.directory=/workspace',
                  '-c',
                  `safe.directory=${bareRepoPath}`,
                  '-C',
                  '/workspace',
                  ...args,
                ],
                { timeout: 30_000 },
              );
              return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
            },
            bareRepoPath,
            podId,
          );
          if (result.pushed) {
            pushed = true;
          } else {
            // Surface as pushed=false rather than throwing. The caller uses pushed=false
            // to clamp auto-commit's deletion guard so a partially-synced worktree can't
            // get swept into a single bogus chore commit via `git add -A`.
            logger.warn(
              { worktreePath, reason: result.reason },
              'Git push to bare during sync-back failed — agent commits not on host branch',
            );
          }
        }
      }

      // Sync files back, excluding git/dependency/tooling caches. The caches are ignored
      // runtime state and can contain platform-native binaries; mirroring them between a
      // Linux container and a macOS host makes host-side browser facts load the wrong binary.
      //
      // Important: never clear the host worktree before the replacement is complete.
      // Docker Desktop / VirtioFS stalls can kill an exec halfway through. The old
      // clear-then-copy sequence left the host tree partially empty, which `git add -A`
      // interpreted as thousands of deletions. This is copy-first/delete-after:
      //  1. Copy /workspace into a staging dir inside the bind mount.
      //  2. Copy the staged content over the host worktree.
      //  3. Delete host paths that are absent from the complete staged copy.
      const syncStagingPrefix = `.autopod-sync-${podId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const syncScript = [
        'set -eu',
        "find /mnt/worktree -mindepth 1 -maxdepth 1 \\( -name '.autopod-sync-*' -o -name '.autopod-extract-*' \\) -exec rm -rf {} +",
        `STAGING="/mnt/worktree/${syncStagingPrefix}-$$"`,
        'STAGING_BASE=$(basename "$STAGING")',
        'trap \'rm -rf "$STAGING"\' EXIT INT TERM',
        'rm -rf "$STAGING"',
        'mkdir -p "$STAGING"',
        `workspace_count=$(cd /workspace && find . -mindepth 1 ${workspaceMirrorPruneExpression(
          WORKSPACE_SYNC_EXCLUDES,
        )} -print | wc -l | tr -d " ")`,
        buildWorkspaceMirrorCopyScript('/workspace', '"$STAGING"', WORKSPACE_SYNC_EXCLUDES),
        'staging_count=$(find "$STAGING" -mindepth 1 | wc -l | tr -d " ")',
        'test "$workspace_count" = "$staging_count"',
        'cp -a "$STAGING/." /mnt/worktree/',
        'cd /mnt/worktree',
        [
          'find . -mindepth 1 -depth',
          ...workspaceMirrorPreservePredicates(WORKSPACE_SYNC_EXCLUDES),
          '! -path "./$STAGING_BASE"',
          '! -path "./$STAGING_BASE/*"',
          '-exec sh -c \'staging=$1; shift; for p do rel=${p#./}; if [ ! -e "$staging/$rel" ] && [ ! -L "$staging/$rel" ]; then rm -rf -- "$p"; fi; done\' sh "$STAGING" {} +',
        ].join(' '),
        'rm -rf "$STAGING"',
      ].join('; ');
      const syncResult = await cm.execInContainer(containerId, ['sh', '-c', syncScript], {
        timeout: 120_000,
      });
      if (syncResult.exitCode !== 0) {
        throw new Error(
          `Workspace sync-back command failed (exit ${syncResult.exitCode}): ${syncResult.stderr.trim() || syncResult.stdout.trim()}`,
        );
      }
      if (pushed) {
        await refreshHostWorktreeIndex(worktreePath, podId);
      }
    } catch (err) {
      // Fall back to the Docker archive API on any exec failure — getArchive() works on both
      // running and stopped (but not yet removed) containers. Previously only 409
      // (stopped-container) errors triggered this path; timeouts from VirtioFS stalls on
      // Docker Desktop for Mac or large workspace copies silently re-threw, which left the
      // host worktree partially populated and caused the deletion guard to fire.
      logger.warn(
        { err, worktreePath },
        'In-container sync command failed — falling back to archive API extraction',
      );

      ({ pushed } = await extractWorkspaceBackAndRecoverGit(containerId, worktreePath, cm, podId));
    }
    return { pushed };
  }

  async function extractWorkspaceBackAndRecoverGit(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
  ): Promise<{ pushed: boolean }> {
    let pushed = false;
    // Extract workspace files excluding .git so the host gitlink is preserved.
    await cm.extractDirectoryFromContainer(
      containerId,
      '/workspace',
      worktreePath,
      WORKSPACE_SYNC_EXCLUDES,
    );

    // Try to recover commits: extract the container's .git to a temp dir and push to bare.
    let bareRepoPath: string | null = null;
    try {
      // Host worktree gitlink is intact (we excluded .git above), so we can derive the path.
      bareRepoPath = await deriveBareRepoPath(worktreePath);
    } catch {
      // Best-effort — if we can't get the bare path, commit recovery is skipped.
    }
    if (bareRepoPath) {
      const tmpGitDir = path.join(os.tmpdir(), `autopod-git-${Date.now()}`);
      try {
        await mkdir(tmpGitDir, { recursive: true });
        // Extract /workspace/.git into tmpGitDir — the alternates inside point at the bare,
        // so git can resolve baseline objects and push only the new ones.
        await cm.extractDirectoryFromContainer(containerId, '/workspace/.git', tmpGitDir);
        const result = await pushCommitsToBareViaStagingRef(
          async (args) => {
            try {
              const r = await execFileAsync('git', ['--git-dir', tmpGitDir, ...args]);
              return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
            } catch (err) {
              const e = err as { stdout?: string; stderr?: string; code?: number };
              return {
                stdout: e.stdout ?? '',
                stderr: e.stderr ?? (err as Error).message,
                exitCode: typeof e.code === 'number' ? e.code : 1,
              };
            }
          },
          bareRepoPath,
          podId,
        );
        if (result.pushed) {
          pushed = true;
        } else {
          logger.warn(
            { worktreePath, reason: result.reason },
            'Could not push commits from container during sync fallback — new commits may be lost',
          );
        }
      } catch (gitRecoveryErr) {
        logger.warn(
          { err: gitRecoveryErr, worktreePath },
          'Could not push commits from container during sync fallback — new commits may be lost',
        );
      } finally {
        await rm(tmpGitDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (pushed) {
      await refreshHostWorktreeIndex(worktreePath, podId);
    }
    return { pushed };
  }

  /**
   * Attempt to recover a partially-synced host worktree by pulling files directly from a
   * still-running container. Returns true on success, false if the container is gone or the
   * extraction fails (caller should fall through to the compromised path).
   */
  async function recoverWorktreeFromContainer(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
  ): Promise<boolean> {
    try {
      const status = await cm.getStatus(containerId);
      if (status !== 'running') {
        logger.warn(
          { containerId, worktreePath },
          'Cannot recover worktree — container not running',
        );
        return false;
      }

      // Push any commits the agent made inside the container to the bare repo first.
      const alternatesResult = await cm.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          "sed 's|/objects$||' /workspace/.git/objects/info/alternates 2>/dev/null | head -1 || true",
        ],
        { timeout: 5_000 },
      );
      const containerBareRepoPath =
        alternatesResult.exitCode === 0 && alternatesResult.stdout.trim()
          ? alternatesResult.stdout.trim()
          : null;

      if (containerBareRepoPath) {
        let expectedBareRepoPath: string | null = null;
        try {
          expectedBareRepoPath = await deriveBareRepoPath(worktreePath);
        } catch {}
        if (expectedBareRepoPath && containerBareRepoPath === expectedBareRepoPath) {
          const result = await pushCommitsToBareViaStagingRef(
            async (args) => {
              const r = await cm.execInContainer(
                containerId,
                ['git', '-C', '/workspace', ...args],
                { timeout: 30_000 },
              );
              return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
            },
            containerBareRepoPath,
            podId,
          );
          if (!result.pushed) {
            logger.warn(
              { worktreePath, reason: result.reason },
              'Git push during worktree recovery failed — commits may not be fully visible on host',
            );
          }
        }
      }

      await cm.extractDirectoryFromContainer(
        containerId,
        '/workspace',
        worktreePath,
        WORKSPACE_SYNC_EXCLUDES,
      );
      await refreshHostWorktreeIndex(worktreePath, podId);
      logger.info({ containerId, worktreePath }, 'Worktree repopulated from live container');
      return true;
    } catch (err) {
      logger.warn({ err, containerId, worktreePath }, 'Live container worktree recovery failed');
      return false;
    }
  }

  async function refreshHostWorktreeIndex(worktreePath: string, podId: string): Promise<void> {
    try {
      await execFileAsync('git', ['reset', '--mixed', 'HEAD'], { cwd: worktreePath });
      logger.info({ podId, worktreePath }, 'Refreshed host worktree index after sync-back');
    } catch (err) {
      logger.warn(
        { err, podId, worktreePath },
        'Failed to refresh host worktree index after sync-back',
      );
      throw err;
    }
  }

  return { syncWorkspaceBack, recoverWorktreeFromContainer };
}
