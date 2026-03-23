import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type {
  DiffStats,
  MergeBranchConfig,
  WorktreeCreateConfig,
  WorktreeManager,
} from '../interfaces/worktree-manager.js';

const execFileAsync = promisify(execFile);

export interface LocalWorktreeManagerConfig {
  cacheDir?: string;
  worktreeDir?: string;
  logger: Logger;
}

/**
 * Git bare-repo cache + worktree manager for local-first execution.
 *
 * Avoids cloning every time by maintaining bare repos as a cache layer.
 * Each session gets its own worktree checked out from the bare repo.
 */
export class LocalWorktreeManager implements WorktreeManager {
  private cacheDir: string;
  private worktreeDir: string;
  private logger: Logger;

  /** Per-repo mutex to avoid git lock contention during concurrent fetches. */
  private repoLocks = new Map<string, Promise<void>>();

  constructor(config: LocalWorktreeManagerConfig) {
    this.cacheDir =
      config.cacheDir ??
      process.env.AUTOPOD_REPO_CACHE ??
      path.join(os.homedir(), '.autopod', 'repos');
    this.worktreeDir =
      config.worktreeDir ??
      process.env.AUTOPOD_WORKTREE_DIR ??
      path.join(os.homedir(), '.autopod', 'worktrees');
    this.logger = config.logger;
  }

  async create(config: WorktreeCreateConfig): Promise<string> {
    const { repoUrl, branch, baseBranch } = config;
    const cacheKey = this.sanitizeRepoUrl(repoUrl);
    const bareRepoPath = path.join(this.cacheDir, `${cacheKey}.git`);

    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.mkdir(this.worktreeDir, { recursive: true });

    // Ensure bare repo exists and is up-to-date (with per-repo locking)
    await this.withRepoLock(cacheKey, async () => {
      const exists = await this.pathExists(bareRepoPath);
      if (!exists) {
        this.logger.info({ repoUrl, bareRepoPath }, 'Cloning bare repo');
        await execFileAsync('git', ['clone', '--bare', repoUrl, bareRepoPath]);
      } else {
        this.logger.info({ bareRepoPath }, 'Fetching latest into bare repo');
        // Explicit refspec per CLAUDE.md — wildcard fetches fail on Azure File Share
        await execFileAsync(
          'git',
          ['fetch', 'origin', `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`],
          { cwd: bareRepoPath },
        );
      }
    });

    // Create worktree — use session-derived path
    const sessionDir = branch.replace(/[^a-zA-Z0-9_-]/g, '_');
    const worktreePath = path.join(this.worktreeDir, sessionDir);

    this.logger.info({ worktreePath, branch, baseBranch }, 'Creating worktree');

    // -B force-creates branch to handle retry scenarios
    await execFileAsync('git', ['worktree', 'add', '-B', branch, worktreePath, baseBranch], {
      cwd: bareRepoPath,
    });

    return worktreePath;
  }

  async cleanup(worktreePath: string): Promise<void> {
    // Find the bare repo that owns this worktree
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
        cwd: worktreePath,
      });
      const bareRepoPath = path.resolve(worktreePath, stdout.trim());

      await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: bareRepoPath,
      }).catch(async () => {
        // Fallback: rm -rf if git worktree remove fails
        this.logger.warn({ worktreePath }, 'git worktree remove failed, falling back to rm -rf');
        await fs.rm(worktreePath, { recursive: true, force: true });
      });

      // Prune stale worktree refs
      await execFileAsync('git', ['worktree', 'prune'], { cwd: bareRepoPath }).catch(() => {
        // Non-fatal
      });
    } catch {
      // If we can't determine the bare repo, just nuke the directory
      this.logger.warn({ worktreePath }, 'Cannot determine bare repo, removing directory directly');
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  }

  async getDiffStats(worktreePath: string, baseBranch?: string): Promise<DiffStats> {
    try {
      // Compare committed changes against the base branch (the branch we forked from).
      // Plain `git diff --stat HEAD` only shows *uncommitted* changes, which is empty
      // when the agent commits as it goes (Claude Code does this).
      if (baseBranch) {
        // Find the merge-base so we only count commits on this branch
        const { stdout: mergeBase } = await execFileAsync(
          'git',
          ['merge-base', 'HEAD', baseBranch],
          { cwd: worktreePath },
        );
        const { stdout } = await execFileAsync(
          'git',
          ['diff', '--stat', mergeBase.trim(), 'HEAD'],
          { cwd: worktreePath },
        );
        return this.parseDiffStats(stdout);
      }

      // Fallback: uncommitted changes only (legacy behaviour)
      const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], {
        cwd: worktreePath,
      });

      return this.parseDiffStats(stdout);
    } catch {
      return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    }
  }

  async getDiff(worktreePath: string, baseBranch: string, maxLength = 50_000): Promise<string> {
    try {
      const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', 'HEAD', baseBranch], {
        cwd: worktreePath,
      });
      const { stdout } = await execFileAsync('git', ['diff', mergeBase.trim(), 'HEAD'], {
        cwd: worktreePath,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout.slice(0, maxLength);
    } catch {
      return '';
    }
  }

  async mergeBranch(config: MergeBranchConfig): Promise<void> {
    const { worktreePath, targetBranch } = config;

    // Commit any uncommitted work
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
      await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: worktreePath });
      // No staged changes — skip commit
    } catch {
      // There are staged changes — commit them
      await execFileAsync(
        'git',
        ['commit', '-m', 'chore: auto-commit uncommitted changes before merge'],
        { cwd: worktreePath },
      );
    }

    // Push the branch to origin
    this.logger.info({ worktreePath, targetBranch }, 'Pushing branch to origin');
    await execFileAsync('git', ['push', 'origin', 'HEAD'], { cwd: worktreePath });
  }

  async commitFiles(worktreePath: string, paths: string[], message: string): Promise<void> {
    if (paths.length === 0) return;

    try {
      // Stage the specific paths
      await execFileAsync('git', ['add', ...paths], { cwd: worktreePath });

      // Check if there's anything staged
      try {
        await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: worktreePath });
        // Exit 0 means nothing staged — skip commit
        return;
      } catch {
        // Exit non-zero means there ARE staged changes — commit them
      }

      await execFileAsync('git', ['commit', '-m', message], { cwd: worktreePath });
      this.logger.info({ worktreePath, fileCount: paths.length }, 'Committed files');
    } catch (err) {
      this.logger.warn({ err, worktreePath }, 'Failed to commit files');
    }
  }

  // --- Private helpers ---

  private sanitizeRepoUrl(url: string): string {
    // "https://github.com/org/repo.git" → "github.com_org_repo"
    return url
      .replace(/^https?:\/\//, '')
      .replace(/\.git$/, '')
      .replace(/[/:]/g, '_');
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private parseDiffStats(output: string): DiffStats {
    // Last line of `git diff --stat` looks like:
    // " 3 files changed, 50 insertions(+), 10 deletions(-)"
    const lines = output.trim().split('\n');
    const summary = lines[lines.length - 1] ?? '';

    const filesMatch = summary.match(/(\d+)\s+file/);
    const addMatch = summary.match(/(\d+)\s+insertion/);
    const delMatch = summary.match(/(\d+)\s+deletion/);

    return {
      filesChanged: filesMatch?.[1] ? Number.parseInt(filesMatch[1], 10) : 0,
      linesAdded: addMatch?.[1] ? Number.parseInt(addMatch[1], 10) : 0,
      linesRemoved: delMatch?.[1] ? Number.parseInt(delMatch[1], 10) : 0,
    };
  }

  /** Serialize operations on the same repo to avoid git lock contention. */
  private async withRepoLock(key: string, fn: () => Promise<void>): Promise<void> {
    const existing = this.repoLocks.get(key) ?? Promise.resolve();
    const next = existing.then(fn, fn); // Run fn regardless of prior result
    this.repoLocks.set(key, next);
    try {
      await next;
    } finally {
      // Clean up if we're still the latest
      if (this.repoLocks.get(key) === next) {
        this.repoLocks.delete(key);
      }
    }
  }
}
