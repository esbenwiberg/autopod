import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecutionTarget } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/index.js';
import { deriveBareRepoPath } from '../worktrees/bare-push.js';
import { graftHostTreeOntoBase } from '../worktrees/graft-reconcile.js';
import { transferCommitToContainer } from '../worktrees/sandbox-reconcile.js';

const execFileAsync = promisify(execFile);

export interface ValidationWorkspaceDependencies {
  logger: Pick<Logger, 'info' | 'warn'>;
  syncWorkspaceBack(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
    executionTarget: ExecutionTarget,
  ): Promise<{ pushed: boolean }>;
}

export class ValidationWorkspaceReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationWorkspaceReconcileError';
  }
}

export function createValidationWorkspace(deps: ValidationWorkspaceDependencies) {
  const { logger, syncWorkspaceBack } = deps;

  async function readHostWorktreeHead(worktreePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: worktreePath,
      });
      return stdout.trim() || null;
    } catch (err) {
      logger.warn({ err, worktreePath }, 'Could not read host worktree HEAD');
      return null;
    }
  }

  async function readHostWorktreeStatus(worktreePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: worktreePath,
      });
      return stdout;
    } catch (err) {
      logger.warn({ err, worktreePath }, 'Could not read host worktree status');
      return null;
    }
  }

  async function readContainerWorktreeHead(
    containerId: string,
    cm: ContainerManager,
  ): Promise<string | null> {
    try {
      const result = await cm.execInContainer(
        containerId,
        ['git', '-C', '/workspace', 'rev-parse', 'HEAD'],
        { timeout: 10_000 },
      );
      if (result.exitCode !== 0) {
        logger.warn(
          { containerId, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
          'Could not read container workspace HEAD',
        );
        return null;
      }
      return result.stdout.trim() || null;
    } catch (err) {
      logger.warn({ err, containerId }, 'Could not read container workspace HEAD');
      return null;
    }
  }

  async function readContainerWorktreeStatus(
    containerId: string,
    cm: ContainerManager,
  ): Promise<string | null> {
    try {
      const result = await cm.execInContainer(
        containerId,
        ['git', '-C', '/workspace', 'status', '--porcelain'],
        { timeout: 10_000 },
      );
      if (result.exitCode !== 0) {
        logger.warn(
          { containerId, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
          'Could not read container workspace status',
        );
        return null;
      }
      return result.stdout;
    } catch (err) {
      logger.warn({ err, containerId }, 'Could not read container workspace status');
      return null;
    }
  }

  async function isAncestorInContainer(
    containerId: string,
    cm: ContainerManager,
    ancestor: string,
    descendant: string,
  ): Promise<boolean | null> {
    const result = await cm.execInContainer(
      containerId,
      ['git', '-C', '/workspace', 'merge-base', '--is-ancestor', ancestor, descendant],
      { timeout: 10_000 },
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    logger.warn(
      {
        containerId,
        ancestor,
        descendant,
        exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 500),
      },
      'Could not compare host/container workspace ancestry',
    );
    return null;
  }

  async function resetContainerWorkspaceToHead(
    containerId: string,
    cm: ContainerManager,
    head: string,
  ): Promise<void> {
    const reset = await cm.execInContainer(
      containerId,
      ['git', '-C', '/workspace', 'reset', '--hard', head],
      { timeout: 30_000 },
    );
    if (reset.exitCode !== 0) {
      throw new ValidationWorkspaceReconcileError(
        `Could not reset validation container to host HEAD ${head}: ${reset.stderr.trim() || reset.stdout.trim()}`,
      );
    }

    const clean = await cm.execInContainer(
      containerId,
      ['git', '-C', '/workspace', 'clean', '-fd'],
      {
        timeout: 30_000,
      },
    );
    if (clean.exitCode !== 0) {
      throw new ValidationWorkspaceReconcileError(
        `Could not clean validation container after reset to ${head}: ${clean.stderr.trim() || clean.stdout.trim()}`,
      );
    }
  }

  /**
   * Recover from a host/container HEAD divergence on **sandbox** pods without
   * quarantining the worktree.
   *
   * On sandbox the container is the source of truth: the host worktree is a
   * staging area whose files are extracted from `/workspace` and then
   * auto-committed host-side. When the daemon's own auto-commit lands on a base
   * that isn't a descendant of the container HEAD, the two HEADs diverge in
   * *ancestry* even though the host commit's *tree* is exactly the agent state
   * we want to validate.
   *
   * We reconcile by grafting the host worktree's tree onto the container HEAD:
   *   reset --soft <containerHead>  → keep the host tree, re-parent onto container
   *   commit (if the trees differ)  → linear child of container HEAD
   * then reset the container to the grafted HEAD. This preserves 100% of the
   * agent's file content and yields a linear branch, so validation and PR
   * delivery proceed normally instead of the work being stranded.
   *
   * Returns true when the worktree was reconciled, false when we could not make
   * the container HEAD available on the host (caller should fall back to the
   * divergence throw / quarantine).
   */
  async function reconcileDivergedSandboxWorkspace(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
    hostHead: string,
    containerHead: string,
  ): Promise<boolean> {
    const hostGit = async (args: string[]) => {
      try {
        const r = await execFileAsync('git', args, { cwd: worktreePath });
        return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: e.stdout ?? '',
          stderr: e.stderr ?? (err as Error).message,
          exitCode: typeof e.code === 'number' ? e.code : 1,
        };
      }
    };

    const containerGit = async (args: string[]) => {
      const r = await cm.execInContainer(
        containerId,
        ['git', '-c', 'safe.directory=/workspace', '-C', '/workspace', ...args],
        { timeout: 30_000 },
      );
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    };

    // Capture the full lineage before touching anything — this is the repro data
    // that pins down *why* the auto-commit diverged (see sandbox-rework-reconcile-bug.md).
    const [mergeBase, hostTree, containerTree] = await Promise.all([
      hostGit(['merge-base', hostHead, containerHead]).then((r) =>
        r.exitCode === 0 ? r.stdout.trim() : null,
      ),
      hostGit(['rev-parse', `${hostHead}^{tree}`]).then((r) =>
        r.exitCode === 0 ? r.stdout.trim() : null,
      ),
      hostGit(['rev-parse', `${containerHead}^{tree}`]).then((r) =>
        r.exitCode === 0 ? r.stdout.trim() : null,
      ),
    ]);
    logger.warn(
      { podId, hostHead, containerHead, mergeBase, hostTree, containerTree },
      'Sandbox workspace HEADs diverged — attempting recoverable reconcile',
    );

    // Derive the bare repo path up front — needed both to push the container HEAD
    // to a throwaway ref (if it isn't already on the host) and to clean that ref up.
    let bareRepoPath: string | null = null;
    try {
      bareRepoPath = await deriveBareRepoPath(worktreePath);
    } catch {
      // Best-effort; the cat-file check below is the real gate.
    }
    const reconcileRef = `refs/autopod-reconcile/${podId}`;
    const cleanupReconcileRef = async () => {
      if (!bareRepoPath) return;
      await execFileAsync('git', [
        '--git-dir',
        bareRepoPath,
        'update-ref',
        '-d',
        reconcileRef,
      ]).catch(() => {});
    };

    // The graft needs the container HEAD reachable as an object on the host. It
    // usually is (sync-back pushed it to the bare); if not, push it now to a
    // throwaway ref so the object exists without moving any branch.
    const ensureContainerHeadReachable = async (): Promise<boolean> => {
      if ((await hostGit(['cat-file', '-e', `${containerHead}^{commit}`])).exitCode === 0) {
        return true;
      }
      if (!bareRepoPath) {
        logger.warn(
          { podId, containerHead },
          'Cannot reconcile diverged workspace — container HEAD missing on host and bare path unknown',
        );
        return false;
      }
      // Validate the daemon-derived bare path against the container's alternates,
      // mirroring the sync-back push guard, before letting the container push to it.
      const alternatesResult = await cm.execInContainer(
        containerId,
        [
          'sh',
          '-c',
          "sed 's|/objects$||' /workspace/.git/objects/info/alternates 2>/dev/null | head -1 || true",
        ],
        { timeout: 5_000 },
      );
      const containerBarePath =
        alternatesResult.exitCode === 0 && alternatesResult.stdout.trim()
          ? alternatesResult.stdout.trim()
          : null;
      if (!containerBarePath || containerBarePath !== bareRepoPath) {
        logger.warn(
          { podId, bareRepoPath, containerBarePath },
          'Cannot reconcile diverged workspace — container bare path mismatch, refusing push',
        );
        return false;
      }
      const push = await cm.execInContainer(
        containerId,
        [
          'git',
          '-c',
          'safe.directory=/workspace',
          '-c',
          `safe.directory=${bareRepoPath}`,
          '-C',
          '/workspace',
          'push',
          bareRepoPath,
          `HEAD:${reconcileRef}`,
        ],
        { timeout: 30_000 },
      );
      if (push.exitCode !== 0) {
        logger.warn(
          { podId, containerHead, stderr: push.stderr.slice(0, 500) },
          'Cannot reconcile diverged workspace — failed to make container HEAD available on host',
        );
        return false;
      }
      return true;
    };

    const hostBundlePath = path.join(
      os.tmpdir(),
      `autopod-reconcile-${podId}-${Date.now()}.bundle`,
    );
    const containerBundlePath = `/tmp/autopod-reconcile-${podId}.bundle`;
    try {
      // Both HEADs must be visible host-side to compute the target. containerHead is
      // normally already on the host bare (sync-back pushed it); ensure it if not.
      if (!(await ensureContainerHeadReachable())) return false;

      // Decide the reconciled target commit HOST-SIDE, where both HEADs resolve.
      // The common case is "host ahead" — the daemon's auto-commit sits linearly on
      // top of the container HEAD, so the host commit is already the target. Only on
      // true divergence (neither an ancestor of the other) do we graft the host tree
      // onto the container HEAD to synthesise a linear target.
      const containerAncestorOfHost =
        (await hostGit(['merge-base', '--is-ancestor', containerHead, hostHead])).exitCode === 0;
      let target = hostHead;
      if (!containerAncestorOfHost) {
        const graft = await graftHostTreeOntoBase(hostGit, containerHead);
        if (!graft.ok) {
          logger.warn(
            { podId, hostHead, containerHead, reason: graft.reason },
            'Reconcile graft failed',
          );
          return false;
        }
        target = graft.head;
      }

      if (target === containerHead) {
        // Trees were identical — the HEADs already agree in content. Nothing to move.
        logger.info(
          { podId, hostHead, containerHead },
          'Reconciled diverged sandbox workspace — host and container already share the target tree',
        );
        return true;
      }

      // The sandbox container has an ISOLATED object store and cannot resolve the
      // host-created `target`. Bundle it across (incremental on containerHead, which
      // the container already has) so `target` becomes a real object in the container
      // BEFORE we reset the workspace to it. Resetting to a host-only commit is exactly
      // what broke the first cut of this fix ("Could not parse object").
      const transfer = await transferCommitToContainer({
        hostGit,
        containerGit,
        transferBundle: async (fromHostPath, toContainerPath) => {
          const bytes = await readFile(fromHostPath);
          await cm.writeFile(containerId, toContainerPath, bytes);
        },
        hostBundlePath,
        containerBundlePath,
        transferRef: `refs/autopod-xfer/${podId}`,
        target,
        base: containerHead,
      });
      if (!transfer.ok) {
        logger.warn(
          { podId, hostHead, containerHead, target, reason: transfer.reason },
          'Reconcile failed to transfer target commit into the sandbox container',
        );
        return false;
      }

      // `target` now resolves in the container's own store, so this succeeds on sandbox.
      await resetContainerWorkspaceToHead(containerId, cm, target);
      logger.info(
        { podId, hostHead, containerHead, target },
        'Reconciled diverged sandbox workspace by transferring target commit into the container',
      );
      return true;
    } finally {
      await cleanupReconcileRef();
      await rm(hostBundlePath, { force: true }).catch(() => {});
      await cm
        .execInContainer(containerId, ['rm', '-f', containerBundlePath], { timeout: 5_000 })
        .catch(() => {});
    }
  }

  async function prepareWorkspaceForValidation(
    containerId: string,
    worktreePath: string,
    cm: ContainerManager,
    podId: string,
    executionTarget: ExecutionTarget,
  ): Promise<void> {
    const [hostHead, hostStatus, containerHead, containerStatus] = await Promise.all([
      readHostWorktreeHead(worktreePath),
      readHostWorktreeStatus(worktreePath),
      readContainerWorktreeHead(containerId, cm),
      readContainerWorktreeStatus(containerId, cm),
    ]);

    if (!hostHead || !containerHead) {
      logger.warn(
        { podId, hostHead, containerHead },
        'Could not inspect workspace heads before validation — falling back to sync-back',
      );
      await syncWorkspaceBack(containerId, worktreePath, cm, podId, executionTarget);
      return;
    }

    const hostDirty = hostStatus == null ? null : hostStatus.trim().length > 0;
    const containerDirty = containerStatus == null ? null : containerStatus.trim().length > 0;

    if (hostHead === containerHead) {
      if (containerDirty !== false) {
        await syncWorkspaceBack(containerId, worktreePath, cm, podId, executionTarget);
      }
      return;
    }

    const containerAncestorOfHost = await isAncestorInContainer(
      containerId,
      cm,
      containerHead,
      hostHead,
    );
    if (containerAncestorOfHost === true) {
      logger.info(
        { podId, hostHead, containerHead, hostDirty, containerDirty },
        'Host worktree is ahead of validation container — resetting container to host HEAD',
      );
      await resetContainerWorkspaceToHead(containerId, cm, hostHead);
      return;
    }

    const hostAncestorOfContainer = await isAncestorInContainer(
      containerId,
      cm,
      hostHead,
      containerHead,
    );
    if (hostAncestorOfContainer === true) {
      await syncWorkspaceBack(containerId, worktreePath, cm, podId, executionTarget);
      return;
    }

    // True divergence: neither HEAD is an ancestor of the other. On sandbox the
    // container is authoritative and the host worktree's tree is the agent state
    // we want to validate, so recover by grafting rather than quarantining the
    // worktree. Docker pods keep the strict throw — their host worktree is
    // bind-mounted and should stay linear, so a divergence there is a real anomaly.
    if (executionTarget === 'sandbox') {
      const reconciled = await reconcileDivergedSandboxWorkspace(
        containerId,
        worktreePath,
        cm,
        podId,
        hostHead,
        containerHead,
      );
      if (reconciled) return;
    }

    throw new ValidationWorkspaceReconcileError(
      `Host worktree HEAD ${hostHead} and container workspace HEAD ${containerHead} diverged before validation`,
    );
  }

  return { prepareWorkspaceForValidation };
}
