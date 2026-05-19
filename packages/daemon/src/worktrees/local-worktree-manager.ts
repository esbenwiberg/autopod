import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type {
  BranchFolderContents,
  CommitPendingChangesOptions,
  DiffStats,
  MergeBranchConfig,
  RebaseOntoBaseConfig,
  RebaseOntoBaseResult,
  RestoreFromHeadOptions,
  RestoreFromHeadResult,
  WorktreeCreateConfig,
  WorktreeManager,
  WorktreeResult,
} from '../interfaces/worktree-manager.js';
import { agentToolingCachePaths } from '../pods/agent-tooling-cache-paths.js';
import { KeyedPromiseQueue } from '../util/keyed-promise-queue.js';
import { generateAutoCommitMessage } from './auto-commit-message.js';
import {
  DIFF_EXCLUDE_PATHSPECS,
  stripModeOnlyChanges,
  truncateDiffAtFileBoundary,
} from './diff-utils.js';

const execFileAsync = promisify(execFile);
const AUTOPOD_SYNC_STAGING_PREFIXES = ['.autopod-sync-', '.autopod-extract-'] as const;

/**
 * Thrown when `commitPendingChanges` refuses to commit because the number of staged deletions
 * exceeds the safety threshold. The usual cause is a failed container→host sync that left the
 * worktree partially populated while the git index still references the missing files. Catch
 * this specifically to surface a "worktree compromised" state instead of a generic 500.
 */
export class DeletionGuardError extends Error {
  readonly deletionCount: number;
  readonly threshold: number;
  constructor(deletionCount: number, threshold: number) {
    super(
      `Auto-commit aborted: ${deletionCount} files staged for deletion exceeds threshold of ${threshold}`,
    );
    this.name = 'DeletionGuardError';
    this.deletionCount = deletionCount;
    this.threshold = threshold;
  }
}

// macOS apps launched via GUI or launchd get a stripped PATH that omits /usr/local/bin,
// /opt/homebrew/bin, and even /usr/bin on some setups — causing `spawn git ENOENT`.
// Prepend the canonical git locations so the binary is found regardless of how the daemon started.
const GIT_PATH_PREPEND = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].join(':');

/**
 * Env vars applied to every git subprocess to prevent interactive prompts
 * from hanging the daemon AND to stop ambient credential helpers (macOS
 * keychain, libsecret, gh CLI's helper) from silently answering on the
 * daemon's behalf. We want missing PATs to surface as a clear error here,
 * not authenticate as whichever user happens to be cached on the host.
 */
const GIT_ENV: Record<string, string> = {
  ...process.env,
  PATH: `${GIT_PATH_PREPEND}:${process.env.PATH ?? ''}`,
  // Block tty prompts.
  GIT_TERMINAL_PROMPT: '0',
  // Block any GUI askpass helper that git might spawn for HTTPS auth.
  // Pointing both vars at /bin/true makes them resolve to a no-op binary
  // that prints nothing — git interprets the empty answer as "no creds".
  GIT_ASKPASS: '/bin/true',
  SSH_ASKPASS: '/bin/true',
  // SSH must never prompt either.
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
} as Record<string, string>;

/**
 * Env vars that disable ambient credential helpers for daemon-spawned git.
 * `credential.helper=` (empty value) clears the helper chain for this invocation
 * only — the host's user/system git config is untouched. Without this, a
 * `git push https://github.com/...` (no token in URL) would hit `osxkeychain`
 * or `manager-core` and silently authenticate with whatever account is cached.
 *
 * Set via `GIT_CONFIG_COUNT/KEY/VALUE` env vars rather than `-c k=v` CLI args
 * so tests and tools that introspect git argv don't have to special-case the
 * prefix. Git applies these as ad-hoc config for the single invocation.
 */
const GIT_NO_AMBIENT_CREDS_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'core.askPass',
  GIT_CONFIG_VALUE_1: '',
};

/** Wrapper so every git call in this file gets GIT_ENV — no env-less calls allowed. */
function git(args: string[], options: { cwd?: string; timeout?: number; maxBuffer?: number } = {}) {
  return execFileAsync('git', args, {
    ...options,
    env: { ...GIT_ENV, ...GIT_NO_AMBIENT_CREDS_ENV },
  });
}

/**
 * Thrown when a git remote operation fails because the daemon either has no
 * PAT for this repo or the PAT it has is rejected by the remote. Distinct
 * from generic git errors so the pod manager can park the pod in
 * `awaiting_input` (operator updates the profile, daemon retries) instead of
 * failing terminally.
 */
export class GitCredentialError extends Error {
  /** Inferred remote provider — picks the right PAT slot to refresh. */
  readonly service: 'github' | 'ado';
  /** Original git stderr (sanitized) for debugging. */
  readonly stderr: string;
  /** The op that hit the failure ('push' / 'fetch'). */
  readonly op: string;
  constructor(message: string, service: 'github' | 'ado', op: string, stderr: string) {
    super(message);
    this.name = 'GitCredentialError';
    this.service = service;
    this.op = op;
    this.stderr = stderr;
  }
}

/**
 * Heuristic match for credential-class git failures. Covers the wording
 * across HTTPS/SSH, GitHub, ADO, and BitBucket: missing token, wrong token,
 * insufficient PAT scope. Excludes "Repository not found" (404) on its own
 * because GitHub also surfaces that for genuinely missing repos — only flag
 * it when it co-occurs with auth wording.
 */
const CREDENTIAL_ERROR_PATTERNS: readonly RegExp[] = [
  /authentication failed/i,
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /invalid username or token/i,
  /password authentication is not supported/i,
  /permission to .+ denied to /i,
  /remote: permission denied/i,
  /\b403\b/,
  /\b401\b/,
  /tf401019/i, // ADO: "git was unable to authenticate"
  /tf400813/i, // ADO: "user .* is not authorized"
  /support for password authentication was removed/i,
];

function inferGitService(stderr: string, cmd: string): 'github' | 'ado' {
  const blob = `${cmd}\n${stderr}`.toLowerCase();
  if (
    blob.includes('dev.azure.com') ||
    blob.includes('visualstudio.com') ||
    /\btf\d{6}\b/i.test(blob)
  ) {
    return 'ado';
  }
  return 'github';
}

/**
 * Inspect a sanitized git error and return a `GitCredentialError` if it
 * looks like an auth/permission failure, otherwise return the original
 * error unchanged. Pass results through this AFTER `sanitizeGitError` so
 * regexes match the same text the operator sees in logs.
 */
export function classifyGitError(err: unknown, op: string): unknown {
  if (!(err instanceof Error)) return err;
  const errAsRecord = err as unknown as Record<string, unknown>;
  const stderrRaw = errAsRecord.stderr;
  const cmdRaw = errAsRecord.cmd;
  const stderr = typeof stderrRaw === 'string' ? stderrRaw : '';
  const cmd = typeof cmdRaw === 'string' ? cmdRaw : '';
  const blob = `${err.message}\n${stderr}`;
  const isCredential = CREDENTIAL_ERROR_PATTERNS.some((re) => re.test(blob));
  if (!isCredential) return err;
  const service = inferGitService(stderr, cmd);
  const wrapped = new GitCredentialError(
    `git ${op} rejected: credentials missing or unauthorized for ${service}. Update the profile PAT (it must have write access to the target repo) and resume the pod.`,
    service,
    op,
    stderr.slice(0, 500),
  );
  wrapped.stack = err.stack;
  return wrapped;
}

/** Strip credentials from git error messages/commands so PATs never leak into logs. */
const PAT_PATTERN = /https:\/\/[^@]*@/g;
function sanitizeGitError(err: unknown): unknown {
  if (err instanceof Error) {
    const cleaned = new Error(err.message.replace(PAT_PATTERN, 'https://***@'));
    cleaned.stack = err.stack?.replace(PAT_PATTERN, 'https://***@');
    const errRecord = err as unknown as Record<string, unknown>;
    const cleanedRecord = cleaned as unknown as Record<string, unknown>;
    for (const key of ['cmd', 'stderr', 'stdout'] as const) {
      const val = errRecord[key];
      if (typeof val === 'string') {
        cleanedRecord[key] = val.replace(PAT_PATTERN, 'https://***@');
      }
    }
    return cleaned;
  }
  return err;
}

/**
 * Run `git status --porcelain=v1 -z` and return the raw NUL-separated records.
 * Each record is `XY path` — first 2 chars are status, char 3 is space, rest is path.
 * Renames/copies use `XY orig\0new` but those statuses are blockers anyway.
 */
async function collectPorcelainRecords(worktreePath: string): Promise<string[]> {
  const { stdout } = await git(['status', '--porcelain=v1', '-z'], { cwd: worktreePath });
  return stdout.split('\0').filter((r) => r.length > 0);
}

function categorizePorcelainRecords(records: string[]): {
  deletions: string[];
  modifications: string[];
  blockers: string[];
} {
  const deletions: string[] = [];
  const modifications: string[] = [];
  const blockers: string[] = [];
  for (const rec of records) {
    const xy = rec.slice(0, 2);
    const pathPart = rec.slice(3);
    if (xy === ' D') {
      deletions.push(pathPart);
    } else if (xy === ' M') {
      modifications.push(pathPart);
    } else {
      blockers.push(`${xy} ${pathPart}`);
    }
  }
  return { deletions, modifications, blockers };
}

function recoverablePorcelainState(
  records: string[],
  allowTrackedModifications: boolean,
): {
  deletions: string[];
  modifications: string[];
  blockers: string[];
} {
  const { deletions, modifications, blockers } = categorizePorcelainRecords(records);
  return {
    deletions,
    modifications,
    blockers: allowTrackedModifications
      ? blockers
      : [...blockers, ...modifications.map((p) => ` M ${p}`)],
  };
}

function hasStagedPorcelainChanges(records: string[]): boolean {
  return records.some((record) => {
    const xy = record.slice(0, 2);
    return xy !== '??' && xy[0] !== ' ';
  });
}

function getAutopodSyncStagingPath(record: string): string | null {
  if (record.slice(0, 2) !== '??') return null;
  const pathPart = record.slice(3).replace(/\/$/, '');
  const topLevel = pathPart.split('/')[0];
  if (!topLevel || !AUTOPOD_SYNC_STAGING_PREFIXES.some((prefix) => topLevel.startsWith(prefix))) {
    return null;
  }
  return topLevel;
}

async function removeAutopodSyncStagingRecords(
  worktreePath: string,
  records: string[],
): Promise<boolean> {
  const stagingPaths = new Set<string>();
  for (const record of records) {
    const stagingPath = getAutopodSyncStagingPath(record);
    if (stagingPath) stagingPaths.add(stagingPath);
  }
  if (stagingPaths.size === 0) return false;

  await Promise.all(
    [...stagingPaths].map((stagingPath) =>
      fs.rm(path.join(worktreePath, stagingPath), { recursive: true, force: true }),
    ),
  );
  return true;
}

export interface LocalWorktreeManagerConfig {
  cacheDir?: string;
  worktreeDir?: string;
  logger: Logger;
}

/**
 * Git bare-repo cache + worktree manager for local-first execution.
 *
 * Avoids cloning every time by maintaining bare repos as a cache layer.
 * Each pod gets its own worktree checked out from the bare repo.
 */
export class LocalWorktreeManager implements WorktreeManager {
  private cacheDir: string;
  private worktreeDir: string;
  private logger: Logger;

  /** Per-repo mutex to avoid git lock contention during concurrent fetches. */
  private repoLocks = new KeyedPromiseQueue();

  /**
   * In-memory PAT cache keyed by bare repo path.
   * PATs are never written to the git remote URL — remote stays clean so containers
   * that mount the bare repo cannot read the credential. Host-side git operations
   * (fetch, push) use the auth URL constructed from this cache at call time only.
   */
  private patCache = new Map<string, string>();

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

  async create(config: WorktreeCreateConfig): Promise<WorktreeResult> {
    const { repoUrl, branch, baseBranch, pat } = config;
    const cacheKey = this.sanitizeRepoUrl(repoUrl);
    const bareRepoPath = path.join(this.cacheDir, `${cacheKey}.git`);
    const authUrl = pat ? this.injectPat(repoUrl, pat) : repoUrl;

    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.mkdir(this.worktreeDir, { recursive: true });

    // Update in-memory PAT cache (PAT is never written to the remote URL).
    if (pat) {
      this.patCache.set(bareRepoPath, pat);
    }

    // Create worktree — use sessionId-derived path if provided, else branch-derived
    const sessionDir = config.sessionId ? config.sessionId : branch.replace(/[^a-zA-Z0-9_-]/g, '_');
    const worktreePath = path.join(this.worktreeDir, sessionDir);

    // Ensure bare repo exists, fetch latest, and create worktree — all inside the
    // per-repo lock so the ref cannot change between fetch and worktree add.
    await this.repoLocks.run(cacheKey, async () => {
      const valid = await this.isBareRepoValid(bareRepoPath);
      if (!valid) {
        // Remove any incomplete/stale directory before cloning
        await fs.rm(bareRepoPath, { recursive: true, force: true });
        this.logger.info({ repoUrl, bareRepoPath }, 'Cloning bare repo');
        // Clone with auth URL so the initial fetch authenticates, then immediately
        // reset origin to the clean URL — containers mount the bare repo and must
        // not be able to read the PAT from git config.
        try {
          await git(['clone', '--bare', authUrl, bareRepoPath]);
        } catch (err) {
          throw sanitizeGitError(err);
        }
        await git(['remote', 'set-url', 'origin', repoUrl], {
          cwd: bareRepoPath,
        });
      }

      // Always fetch to populate refs/remotes/origin/* — git clone --bare only creates
      // refs/heads/*, so worktree add would fail without this fetch on a fresh clone.
      // Use auth URL directly so the credential is never persisted in git config.
      this.logger.info({ bareRepoPath }, 'Fetching latest into bare repo');
      // Explicit refspec per CLAUDE.md — wildcard fetches fail on Azure File Share.
      // Fetch baseBranch from remote. If the branch hasn't been pushed yet (e.g. forking
      // a pod that failed before pushing), fall back to the local ref in the bare repo.
      let baseBranchRef = `refs/remotes/origin/${baseBranch}`;
      try {
        await git(
          [
            'fetch',
            authUrl,
            `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
            `+refs/heads/${baseBranch}:refs/heads/${baseBranch}`,
          ],
          { cwd: bareRepoPath },
        );
      } catch (fetchErr) {
        const sanitized = sanitizeGitError(fetchErr);
        this.logger.debug({ err: sanitized }, 'Remote fetch for baseBranch failed');
        // Remote fetch failed — check if the branch exists locally (created by a prior
        // pod's `git worktree add -B` and still in the bare repo after cleanup).
        try {
          await git(['rev-parse', '--verify', `refs/heads/${baseBranch}`], {
            cwd: bareRepoPath,
          });
          baseBranchRef = `refs/heads/${baseBranch}`;
          this.logger.info(
            { baseBranch },
            'baseBranch not on remote — using local ref from bare repo',
          );
        } catch {
          throw new Error(
            `baseBranch "${baseBranch}" not found on remote or locally in ${bareRepoPath}`,
          );
        }
      }

      // If the requested branch already exists on the remote, fetch it and use it
      // as the start point so we don't blow away existing work with -B.
      let startPoint = baseBranchRef;
      if (branch !== baseBranch) {
        try {
          await git(['fetch', authUrl, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
            cwd: bareRepoPath,
          });
          // Fetch succeeded — branch exists on remote, use it as start point
          startPoint = `refs/remotes/origin/${branch}`;
          this.logger.info({ branch }, 'Branch exists on remote — resuming from it');
        } catch {
          // Branch doesn't exist on remote yet — normal for new pods
          this.logger.info({ branch }, 'Branch not found on remote — creating from baseBranch');
        }
      }

      // Clean up stale worktree registration if a previous pod left one behind
      // (e.g. killed pod whose cleanup didn't fully complete).
      // Always try both git worktree remove AND fs.rm — either alone can leave remnants.
      await git(['worktree', 'remove', '--force', worktreePath], {
        cwd: bareRepoPath,
      }).catch(() => {});
      await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      await git(['worktree', 'prune'], { cwd: bareRepoPath }).catch(() => {});

      // -B force-creates branch to handle retry scenarios
      this.logger.info({ worktreePath, branch, startPoint }, 'Creating worktree');
      try {
        await git(['worktree', 'add', '-B', branch, worktreePath, startPoint], {
          cwd: bareRepoPath,
        });
      } catch (addErr: unknown) {
        // Handle "branch already used by worktree at X" — stale/orphaned worktree from a
        // previous pod run (e.g. old branch-name-derived paths before sessionId naming).
        const msg = addErr instanceof Error ? addErr.message : String(addErr);
        const match = /already used by worktree at '(.+)'/.exec(msg);
        if (match?.[1]) {
          const conflictPath = match[1];
          this.logger.warn(
            { conflictPath, branch },
            'Branch locked by orphaned worktree — removing and retrying',
          );
          await git(['worktree', 'remove', '--force', conflictPath], {
            cwd: bareRepoPath,
          }).catch(() => {});
          await fs.rm(conflictPath, { recursive: true, force: true }).catch(() => {});
          await git(['worktree', 'prune'], { cwd: bareRepoPath }).catch(() => {});
          await git(['worktree', 'add', '-B', branch, worktreePath, startPoint], {
            cwd: bareRepoPath,
          });
        } else {
          throw addErr;
        }
      }

      // Defense-in-depth against daemon-injected tooling artifacts leaking into PRs.
      // For workspace pods we still write /workspace/.mcp.json (the user's interactive
      // claude needs project-level discovery); the per-worktree info/exclude makes git
      // ignore it so it can never be staged. This is per-clone, not committed, and
      // invisible to the user.
      await this.appendWorktreeExcludes(worktreePath, ['.mcp.json']).catch((err) => {
        this.logger.warn(
          { err, worktreePath },
          'Failed to write info/exclude — daemon artifacts may leak into commits',
        );
      });
    });

    // Resolve HEAD inside the worktree so callers (pod-manager) can persist
    // startCommitSha *before* the container starts. Without this the diff
    // endpoint would fall back to merge-base-with-baseBranch and surface the
    // entire PR's prior sibling commits as the fix pod's "work". Best-effort:
    // a failure here doesn't fail the whole create — the in-container poller
    // will retry and persist later.
    let startCommitSha = '';
    try {
      const result = await git(['rev-parse', 'HEAD'], { cwd: worktreePath });
      startCommitSha = result.stdout?.trim() ?? '';
    } catch (err) {
      this.logger.warn(
        { err: sanitizeGitError(err), worktreePath },
        'Failed to resolve worktree HEAD — startCommitSha will be captured later by the in-container poller',
      );
    }

    return { worktreePath, bareRepoPath, startCommitSha };
  }

  /**
   * Append entries to the per-worktree git info/exclude file. Resolves the path via
   * `git rev-parse --git-path info/exclude` so worktree mode (where .git is a file)
   * is handled correctly.
   */
  private async appendWorktreeExcludes(worktreePath: string, entries: string[]): Promise<void> {
    if (entries.length === 0) return;
    const { stdout } = await git(['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktreePath,
    });
    const excludePath = path.resolve(worktreePath, stdout.trim());
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch {
      // File absent — first write
    }
    const existingLines = new Set(
      existing
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const toAppend = entries.filter((e) => !existingLines.has(e));
    if (toAppend.length === 0) return;
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    await fs.writeFile(excludePath, `${existing}${prefix}${toAppend.join('\n')}\n`, 'utf8');
  }

  async cleanup(worktreePath: string): Promise<void> {
    // Find the bare repo that owns this worktree
    try {
      const { stdout } = await git(['rev-parse', '--git-common-dir'], {
        cwd: worktreePath,
      });
      const bareRepoPath = path.resolve(worktreePath, stdout.trim());
      this.patCache.delete(bareRepoPath);

      await git(['worktree', 'remove', '--force', worktreePath], {
        cwd: bareRepoPath,
      }).catch(async () => {
        // Fallback: rm -rf if git worktree remove fails
        this.logger.warn({ worktreePath }, 'git worktree remove failed, falling back to rm -rf');
        await fs.rm(worktreePath, { recursive: true, force: true });
      });

      // Prune stale worktree refs
      await git(['worktree', 'prune'], { cwd: bareRepoPath }).catch(() => {
        // Non-fatal
      });
    } catch {
      // If we can't determine the bare repo, just nuke the directory
      this.logger.warn({ worktreePath }, 'Cannot determine bare repo, removing directory directly');
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  }

  async getDiffStats(
    worktreePath: string,
    baseBranch?: string,
    sinceCommit?: string,
  ): Promise<DiffStats> {
    try {
      if (baseBranch || sinceCommit) {
        // biome-ignore lint/style/noNonNullAssertion: guarded by `if (baseBranch || sinceCommit)` — baseBranch is non-null when sinceCommit is absent
        const base = sinceCommit ?? (await this.resolveMergeBase(worktreePath, baseBranch!));

        if (!base) {
          this.logger.warn(
            { worktreePath, baseBranch },
            'getDiffStats: could not resolve base ref — returning zeros',
          );
          return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
        }

        // Committed changes: base..HEAD
        const { stdout: committedStat } = await git(
          ['diff', '--stat', base, 'HEAD', ...DIFF_EXCLUDE_PATHSPECS],
          {
            cwd: worktreePath,
          },
        );
        const committed = this.parseDiffStats(committedStat);

        // Uncommitted changes: working tree vs HEAD (staged + unstaged)
        const { stdout: uncommittedStat } = await git(
          ['diff', '--stat', 'HEAD', ...DIFF_EXCLUDE_PATHSPECS],
          {
            cwd: worktreePath,
          },
        );
        const uncommitted = this.parseDiffStats(uncommittedStat);

        return {
          filesChanged: committed.filesChanged + uncommitted.filesChanged,
          linesAdded: committed.linesAdded + uncommitted.linesAdded,
          linesRemoved: committed.linesRemoved + uncommitted.linesRemoved,
        };
      }

      // Fallback: uncommitted changes only (legacy behaviour)
      const { stdout } = await git(['diff', '--stat', 'HEAD', ...DIFF_EXCLUDE_PATHSPECS], {
        cwd: worktreePath,
      });

      return this.parseDiffStats(stdout);
    } catch (err) {
      this.logger.error({ err, worktreePath }, 'getDiffStats failed — returning zeros');
      return { filesChanged: 0, linesAdded: 0, linesRemoved: 0 };
    }
  }

  async getDiff(
    worktreePath: string,
    baseBranch: string,
    maxLength = 200_000,
    sinceCommit?: string,
  ): Promise<string> {
    const base = sinceCommit ?? (await this.resolveMergeBase(worktreePath, baseBranch));

    if (!base) {
      this.logger.warn(
        { worktreePath, baseBranch },
        'getDiff: could not resolve base ref — returning empty diff',
      );
      return '';
    }

    try {
      const bufOpts = { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 };

      // Single working-tree-vs-base diff. Earlier versions ran `git diff base HEAD`
      // and `git diff HEAD` separately and concatenated the output, which produced
      // a diff text that double-counted files touched by BOTH a commit and the
      // working tree. The classic failure mode: the agent committed adding `foo.cs`
      // (e.g. via the workspace handoff auto-commit) and then later `rm`'d it in
      // the working tree without committing the deletion. The combined output
      // contained two file sections — one "+++ foo.cs (added)" hunk from the
      // committed diff and one "--- foo.cs (deleted)" hunk from the uncommitted
      // diff — and AI reviewers latched onto the first hunk and flagged it as
      // scope creep, even though the net delta against base was zero.
      //
      // `git diff <base>` (single ref) compares the working tree directly to
      // <base>'s tree: committed and uncommitted changes are folded into one
      // coherent net delta. Files added then removed cancel out; files modified
      // multiple times show as a single end-state diff. This is what every
      // current caller (pre-submit reviewer, AI task reviewer, re-validation
      // reviewer) actually wants — they evaluate "what is the agent proposing
      // to land", not the intermediate commit history.
      //
      // Untracked files are still excluded (matches prior behaviour) — they
      // require `--no-index` or `git status -uall` and are intentionally not
      // part of the reviewer's scope.
      const { stdout: rawDiff } = await git(['diff', base, ...DIFF_EXCLUDE_PATHSPECS], bufOpts);

      // If sinceCommit produced an empty diff, fall back to merge-base.
      // This handles the case where the worktree wasn't synced from the container
      // (git history didn't carry over) but the branch diverged from defaultBranch.
      if (!rawDiff.trim() && sinceCommit) {
        const mergeBase = await this.resolveMergeBase(worktreePath, baseBranch);
        if (mergeBase && mergeBase !== sinceCommit) {
          const { stdout: mbDiff } = await git(
            ['diff', mergeBase, ...DIFF_EXCLUDE_PATHSPECS],
            bufOpts,
          );
          return truncateDiffAtFileBoundary(stripModeOnlyChanges(mbDiff), maxLength);
        }
      }

      return truncateDiffAtFileBoundary(stripModeOnlyChanges(rawDiff), maxLength);
    } catch (err) {
      this.logger.warn({ err: sanitizeGitError(err), worktreePath }, 'getDiff: git diff failed');
      return '';
    }
  }

  async mergeBranch(config: MergeBranchConfig): Promise<void> {
    const { worktreePath, targetBranch, pat } = config;

    // If a PAT is explicitly provided, warm the cache so getAuthUrl picks it up.
    if (pat) {
      const { stdout: commonDir } = await git(['rev-parse', '--git-common-dir'], {
        cwd: worktreePath,
      });
      const bareRepoPath = path.resolve(worktreePath, commonDir.trim());
      this.patCache.set(bareRepoPath, pat);
    }

    // Commit any uncommitted work (with deletion guard). Callers that know the worktree may be
    // out of sync with the container should pass `maxDeletions: 0` so a ghost mass-deletion
    // cannot be committed over the agent's real work.
    //
    // Daemon-injected code-intel servers (serena, roslyn-codelens) write per-project state
    // into /workspace at runtime. Excluding those paths here keeps the auto-commit immune to
    // tracked-then-missing flips between container generations — see agent-tooling-cache-paths.ts.
    const excludePaths = agentToolingCachePaths(config.profile?.codeIntelligence);
    if (config.commitMessage) {
      await this.commitPendingChanges(worktreePath, config.commitMessage, {
        maxDeletions: config.maxDeletions ?? 100,
        excludePaths,
      });
    } else if (config.profile && config.podModel) {
      await this.commitPendingChangesWithGeneratedMessage(
        worktreePath,
        config.podTask,
        config.profile,
        config.podModel,
        { maxDeletions: config.maxDeletions ?? 100, excludePaths },
      );
    } else {
      // No profile context (rare — only happens for callers that haven't been
      // updated). Fall back to the heuristic path inside generateAutoCommitMessage
      // by passing a synthetic profile with a null provider.
      this.logger.warn(
        { worktreePath },
        'mergeBranch called without profile/podModel — auto-commit message will be heuristic-only',
      );
      await this.commitPendingChanges(
        worktreePath,
        'chore: auto-commit uncommitted agent changes',
        { maxDeletions: config.maxDeletions ?? 100, excludePaths },
      );
    }

    // Push using auth URL so the PAT is never stored in git config.
    this.logger.info({ worktreePath, targetBranch }, 'Pushing branch to origin');
    const authUrl = await this.getAuthUrl(worktreePath);
    const { stdout: actualBranch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
    });
    if (actualBranch.trim() !== targetBranch) {
      throw new Error(
        `Expected HEAD to be on branch '${targetBranch}' but it is on '${actualBranch.trim()}'`,
      );
    }
    try {
      await git(['push', authUrl, `HEAD:refs/heads/${targetBranch}`], {
        cwd: worktreePath,
      });
    } catch (err) {
      throw classifyGitError(sanitizeGitError(err), 'push');
    }
  }

  async commitFiles(worktreePath: string, paths: string[], message: string): Promise<void> {
    if (paths.length === 0) return;

    try {
      // Stage the specific paths
      await git(['add', ...paths], { cwd: worktreePath });

      // Check if there's anything staged
      try {
        await git(['diff', '--cached', '--quiet'], { cwd: worktreePath });
        // Exit 0 means nothing staged — skip commit
        return;
      } catch {
        // Exit non-zero means there ARE staged changes — commit them
      }

      await git(['commit', '-m', message], { cwd: worktreePath });
      this.logger.info({ worktreePath, fileCount: paths.length }, 'Committed files');
    } catch (err) {
      this.logger.warn({ err, worktreePath }, 'Failed to commit files');
    }
  }

  async commitPendingChanges(
    worktreePath: string,
    message: string,
    options?: CommitPendingChangesOptions,
  ): Promise<boolean> {
    const hasStaged = await this.stageAllChanges(worktreePath, options?.excludePaths);
    if (!hasStaged) return false;
    return this.commitStagedChanges(worktreePath, message, options?.maxDeletions ?? 100);
  }

  async commitPendingChangesWithGeneratedMessage(
    worktreePath: string,
    podTask: string | undefined,
    profile: import('@autopod/shared').Profile,
    podModel: string,
    options?: CommitPendingChangesOptions,
  ): Promise<boolean> {
    // Default the exclude list from the profile when callers haven't supplied one
    // explicitly. mergeBranch already passes an explicit list; direct callers
    // (e.g. recovery in pod-manager) get the right behavior automatically.
    const excludePaths = options?.excludePaths ?? agentToolingCachePaths(profile.codeIntelligence);
    const hasStaged = await this.stageAllChanges(worktreePath, excludePaths);
    if (!hasStaged) return false;
    const result = await generateAutoCommitMessage(
      { worktreePath, podTask, profile, podModel },
      this.logger,
    );
    if (result.usedFallback) {
      this.logger.warn(
        {
          worktreePath,
          profile: profile.name,
          modelProvider: profile.modelProvider,
          fallbackReason: result.fallbackReason,
          fallbackDetail: result.fallbackDetail,
        },
        'auto-commit message used heuristic/template fallback — daemon-side LLM helper failed',
      );
    }
    return this.commitStagedChanges(worktreePath, result.message, options?.maxDeletions ?? 100);
  }

  /**
   * Stage every change in the worktree, optionally skipping pathspec-excluded
   * directories. The exclude list lets us keep daemon-injected code-intel
   * caches (`.serena`, `.roslyn-codelens`, etc.) out of agent commits without
   * polluting the repo's `.gitignore`.
   *
   * Subtle git quirk: `git add -A -- . :(exclude)X` exits 1 with "paths are
   * ignored by one of your .gitignore files" when X is already in `.gitignore`
   * — git treats the explicit pathspec mention (even for exclude!) as a user
   * request to add that ignored path. We pre-filter via `check-ignore` and
   * drop excludes that gitignore already covers, since the pathspec would be
   * redundant *and* fatal in that case.
   */
  private async stageAllChanges(
    worktreePath: string,
    excludePaths?: readonly string[],
  ): Promise<boolean> {
    const args = ['add', '-A'];
    const effective = excludePaths?.length
      ? await this.filterExcludePathsForStaging(worktreePath, excludePaths)
      : [];
    if (effective.length > 0) {
      // `-- . :(exclude)<path>` — git pathspec magic. The leading `.` is required:
      // without it, the exclude pathspecs match nothing because `git add -A` defaults
      // to "everything" but pathspecs must be explicit when any are present.
      args.push('--', '.', ...effective.map((p) => `:(exclude)${p}`));
    }
    await git(args, { cwd: worktreePath });
    try {
      await git(['diff', '--cached', '--quiet'], { cwd: worktreePath });
      // Exit 0 → nothing staged
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Drop exclude paths that gitignore already covers. `check-ignore -q` exits
   * 0 when the path is ignored, 1 otherwise. An ignored path doesn't need an
   * explicit `:(exclude)` pathspec — and the pathspec is actively harmful
   * (see stageAllChanges note). We keep paths that gitignore does NOT cover
   * so the exclude still defends against tracked-but-undesired regressions.
   */
  private async filterExcludePathsForStaging(
    worktreePath: string,
    excludePaths: readonly string[],
  ): Promise<string[]> {
    const kept: string[] = [];
    for (const p of excludePaths) {
      try {
        await git(['check-ignore', '-q', p], { cwd: worktreePath });
        // Exit 0 → already gitignored → drop, the pathspec would be redundant
      } catch {
        // Exit 1 (not ignored) or any other error → keep the explicit exclude
        kept.push(p);
      }
    }
    return kept;
  }

  private async commitStagedChanges(
    worktreePath: string,
    message: string,
    maxDeletions: number,
  ): Promise<boolean> {
    const deletionCount = await this.getStagedDeletionCount(worktreePath);
    if (deletionCount > maxDeletions) {
      await git(['reset', 'HEAD'], { cwd: worktreePath });
      this.logger.error(
        { worktreePath, deletionCount, maxDeletions },
        'Auto-commit aborted: staged deletions exceed safety threshold',
      );
      throw new DeletionGuardError(deletionCount, maxDeletions);
    }
    await git(['commit', '-m', message], { cwd: worktreePath });
    this.logger.info({ worktreePath, deletionCount }, 'Auto-committed pending changes');
    return true;
  }

  private async getStagedDeletionCount(worktreePath: string): Promise<number> {
    const { stdout } = await git(['diff', '--cached', '--diff-filter=D', '--name-only'], {
      cwd: worktreePath,
    });
    return stdout.trim().split('\n').filter(Boolean).length;
  }

  async restoreFromHead(
    worktreePath: string,
    options: RestoreFromHeadOptions = {},
  ): Promise<RestoreFromHeadResult> {
    // `--porcelain=v1` gives a stable two-character status code per path:
    //   columns are XY where X=staged, Y=unstaged. Space = clean.
    //   ' D' → unstaged deletion of a HEAD-tracked file.
    //   ' M' → unstaged modification; only restored on explicit recovery.
    //   '??' → untracked.
    //   Anything else ('M ', 'A ', 'R ', 'U?', etc.) means real work might be present.
    let records = await collectPorcelainRecords(worktreePath);
    if (await removeAutopodSyncStagingRecords(worktreePath, records)) {
      records = await collectPorcelainRecords(worktreePath);
    }

    if (options.allowTrackedModifications && hasStagedPorcelainChanges(records)) {
      await git(['reset', '--mixed', 'HEAD'], { cwd: worktreePath });
      records = await collectPorcelainRecords(worktreePath);
    }

    if (records.length === 0) {
      // Clean tree means the worktree already matches HEAD — semantically
      // "restored" (nothing to do, nothing wrong). Return success so the
      // caller can clear worktreeCompromised. Refusing here would trap the
      // pod in a state where the user can't get out of compromised after
      // they manually committed/stashed dirty changes.
      return {
        restored: true,
        reason: 'Working tree already matches HEAD — no restore needed',
        restoredCount: 0,
      };
    }

    const allowTrackedModifications = options.allowTrackedModifications === true;
    let { deletions, modifications, blockers } = recoverablePorcelainState(
      records,
      allowTrackedModifications,
    );

    // If `.gitignore` itself was wiped along with the rest of the working tree
    // (typical: laptop sleep killed sync-back mid-rm), the porcelain check is
    // poisoned. Without `.gitignore` in the working tree, every previously-
    // ignored path (build artifacts, node_modules, .env) flips from "ignored"
    // to `??` and looks like new untracked work — refuse fires for files that
    // would normally not even be visible to git. Restore deleted ignore files
    // from the index first, then re-evaluate. Targeted to ignore files only so
    // we don't silently mask other deletions before the blocker check.
    const deletedIgnoreFiles = deletions.filter(
      (p) => p === '.gitignore' || p.endsWith('/.gitignore'),
    );
    if (deletedIgnoreFiles.length > 0 && blockers.length > 0) {
      try {
        await git(['checkout', '--', ...deletedIgnoreFiles], { cwd: worktreePath });
        records = await collectPorcelainRecords(worktreePath);
        ({ deletions, modifications, blockers } = recoverablePorcelainState(
          records,
          allowTrackedModifications,
        ));
        if (records.length === 0) {
          // Restoring just the ignore files left the tree clean — every other
          // entry was an ignored-but-temporarily-untracked artifact.
          this.logger.info(
            { worktreePath, restoredCount: deletedIgnoreFiles.length },
            'Restored deleted .gitignore files from HEAD; remaining tree was already clean once ignores reapplied',
          );
          return {
            restored: true,
            reason: `Restored ${deletedIgnoreFiles.length} deleted .gitignore file${
              deletedIgnoreFiles.length === 1 ? '' : 's'
            } from HEAD`,
            restoredCount: deletedIgnoreFiles.length,
          };
        }
      } catch (err) {
        // Pre-restore is best-effort. If it fails we fall through to the
        // original blocker check — the worst case is the same refusal we'd
        // have hit anyway, never a silent restore over real work.
        this.logger.warn(
          { err, worktreePath, deletedIgnoreFiles },
          'Failed to pre-restore .gitignore files during recovery — blocker check may still be poisoned',
        );
      }
    }

    if (blockers.length > 0) {
      // Cap the sample so a 1000-file dirty tree doesn't dump everything into the log.
      const sample = blockers.slice(0, 5).join('; ');
      return {
        restored: false,
        reason: `Refusing to restore — ${blockers.length} non-deletion change${blockers.length === 1 ? '' : 's'} present (sample: ${sample})`,
        restoredCount: 0,
      };
    }

    const restoredCount = deletions.length + modifications.length;

    // All entries are recoverable tracked-file damage. `git checkout -- .`
    // restores them from the index without touching HEAD or the index itself —
    // safer than `git reset --hard HEAD`, which would also blow away any state
    // we missed in the porcelain check.
    try {
      await git(['checkout', '--', '.'], { cwd: worktreePath });
    } catch (err) {
      return {
        restored: false,
        reason: `git checkout failed: ${err instanceof Error ? err.message : String(err)}`,
        restoredCount: 0,
      };
    }

    this.logger.info(
      { worktreePath, restoredCount, deletionCount: deletions.length },
      'Restored tracked files from HEAD',
    );
    const reason =
      modifications.length === 0
        ? `Restored ${deletions.length} deleted file${deletions.length === 1 ? '' : 's'} from HEAD`
        : `Restored ${restoredCount} tracked file${restoredCount === 1 ? '' : 's'} from HEAD`;
    return {
      restored: true,
      reason,
      restoredCount,
    };
  }

  async pushBranch(
    worktreePath: string,
    expectedBranch: string,
    options?: { force?: boolean; pat?: string },
  ): Promise<void> {
    const force = options?.force === true;
    this.logger.info({ worktreePath, expectedBranch, force }, 'Pushing branch to origin');
    const { stdout: actualBranch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
    });
    if (actualBranch.trim() !== expectedBranch) {
      throw new Error(
        `Expected HEAD to be on branch '${expectedBranch}' but it is on '${actualBranch.trim()}'`,
      );
    }
    if (options?.pat) {
      const { stdout: commonDir } = await git(['rev-parse', '--git-common-dir'], {
        cwd: worktreePath,
      });
      const bareRepoPath = path.resolve(worktreePath, commonDir.trim());
      this.patCache.set(bareRepoPath, options.pat);
    }
    const authUrl = await this.getAuthUrl(worktreePath);
    // --force-with-lease (not --force) — refuses the push if origin/<branch> moved
    // since our last fetch. Protects against clobbering a teammate's commits when
    // pushing a rebased branch.
    const pushArgs = force
      ? ['push', '--force-with-lease', authUrl, `HEAD:refs/heads/${expectedBranch}`]
      : ['push', authUrl, `HEAD:refs/heads/${expectedBranch}`];
    try {
      await git(pushArgs, { cwd: worktreePath });
    } catch (err) {
      throw classifyGitError(sanitizeGitError(err), 'push');
    }
  }

  async rebaseOntoBase(config: RebaseOntoBaseConfig): Promise<RebaseOntoBaseResult> {
    const { worktreePath, baseBranch, pat } = config;

    // Warm the PAT cache when caller supplies one — mirrors mergeBranch().
    if (pat) {
      const { stdout: commonDir } = await git(['rev-parse', '--git-common-dir'], {
        cwd: worktreePath,
      });
      const bareRepoPath = path.resolve(worktreePath, commonDir.trim());
      this.patCache.set(bareRepoPath, pat);
    }

    const authUrl = await this.getAuthUrl(worktreePath);

    // Fetch the latest base into refs/remotes/origin/<baseBranch>. Explicit refspec
    // per CLAUDE.md — wildcard fetches fail on Azure File Share.
    try {
      await git(['fetch', authUrl, `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], {
        cwd: worktreePath,
      });
    } catch (err) {
      throw sanitizeGitError(err);
    }

    const baseRef = `refs/remotes/origin/${baseBranch}`;

    // Fast-forward check: if origin/<base> is already an ancestor of HEAD, the
    // branch is up to date — skip the rebase entirely.
    try {
      await git(['merge-base', '--is-ancestor', baseRef, 'HEAD'], { cwd: worktreePath });
      this.logger.info(
        { worktreePath, baseBranch },
        'rebaseOntoBase: branch already includes base tip — no rebase needed',
      );
      return { alreadyUpToDate: true, rebased: true, conflicts: [] };
    } catch {
      // Non-zero exit means base has commits not in HEAD — proceed with rebase.
    }

    this.logger.info(
      { worktreePath, baseBranch, baseRef },
      'rebaseOntoBase: rebasing branch onto latest base',
    );

    try {
      await git(['rebase', baseRef], { cwd: worktreePath });
      return { alreadyUpToDate: false, rebased: true, conflicts: [] };
    } catch (rebaseErr) {
      // Conflict (or other failure). Capture conflicting files, then abort so
      // the worktree is restored to its pre-rebase state. We never leave a
      // worktree in a partial rebase — callers either get a clean rebased
      // branch or the original branch back, never half-applied state.
      const conflicts = await this.getRebaseConflicts(worktreePath);
      try {
        await git(['rebase', '--abort'], { cwd: worktreePath });
      } catch (abortErr) {
        this.logger.warn(
          { err: sanitizeGitError(abortErr), worktreePath },
          'rebaseOntoBase: rebase --abort failed after a conflict — worktree may be in inconsistent state',
        );
      }
      this.logger.warn(
        { worktreePath, baseBranch, conflicts },
        'rebaseOntoBase: rebase aborted due to conflicts',
      );
      // Surface the underlying error in debug logs so operators can diagnose
      // non-conflict failures (e.g. corrupt index) — but don't throw, since
      // returning a structured result is the contract.
      this.logger.debug(
        { err: sanitizeGitError(rebaseErr), worktreePath },
        'rebaseOntoBase: underlying rebase error',
      );
      return { alreadyUpToDate: false, rebased: false, conflicts };
    }
  }

  /** Returns the list of files reported by `git diff --name-only --diff-filter=U`. */
  private async getRebaseConflicts(worktreePath: string): Promise<string[]> {
    try {
      const { stdout } = await git(['diff', '--name-only', '--diff-filter=U'], {
        cwd: worktreePath,
      });
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  async pullBranch(worktreePath: string): Promise<{ newCommits: boolean }> {
    this.logger.info({ worktreePath }, 'Pulling latest from origin');
    const { stdout: headBefore } = await git(['rev-parse', 'HEAD'], {
      cwd: worktreePath,
    });
    const authUrl = await this.getAuthUrl(worktreePath);
    const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
    });
    try {
      await git(['fetch', authUrl, branch.trim()], {
        cwd: worktreePath,
      });
    } catch (err) {
      throw sanitizeGitError(err);
    }
    await git(['merge', 'FETCH_HEAD', '--ff-only'], { cwd: worktreePath });
    const { stdout: headAfter } = await git(['rev-parse', 'HEAD'], {
      cwd: worktreePath,
    });
    const newCommits = headBefore.trim() !== headAfter.trim();
    this.logger.info({ worktreePath, newCommits }, 'Pull complete');
    return { newCommits };
  }

  async getCommitLog(
    worktreePath: string,
    baseBranch: string,
    maxCommits = 20,
    sinceCommit?: string,
  ): Promise<string> {
    // Try sinceCommit first, then origin/baseBranch, then bare baseBranch
    const rangeRefs = sinceCommit
      ? [`${sinceCommit}..HEAD`]
      : [`origin/${baseBranch}..HEAD`, `${baseBranch}..HEAD`];

    for (const rangeRef of rangeRefs) {
      try {
        const { stdout } = await git(
          ['log', rangeRef, `--max-count=${maxCommits}`, '--format=%h %s%n%b'],
          { cwd: worktreePath },
        );
        return stdout.trim();
      } catch {
        // ref not available — try next
      }
    }

    this.logger.warn(
      { worktreePath, baseBranch },
      'getCommitLog: could not resolve any range ref — returning empty',
    );
    return '';
  }

  /**
   * Read `.md` files under `relPath` on `branch`, directly from the bare repo
   * cache. Fetches the branch first so newly-pushed briefs are visible.
   * Never creates a working tree — uses `git ls-tree` + `git show` which are
   * both read-only and safe to call on the daemon's long-lived bare repo.
   */
  async readBranchFolder(params: {
    repoUrl: string;
    branch: string;
    relPath: string;
    pat?: string;
  }): Promise<BranchFolderContents> {
    const { repoUrl, branch, pat } = params;
    // Normalize relPath: strip leading/trailing slashes, reject escape attempts.
    const relPath = params.relPath.replace(/^\/+|\/+$/g, '');
    if (!relPath || relPath.includes('..')) {
      throw new Error(`Invalid relPath: ${params.relPath}`);
    }

    const cacheKey = this.sanitizeRepoUrl(repoUrl);
    const bareRepoPath = path.join(this.cacheDir, `${cacheKey}.git`);
    const authUrl = pat ? this.injectPat(repoUrl, pat) : repoUrl;
    if (pat) this.patCache.set(bareRepoPath, pat);

    await fs.mkdir(this.cacheDir, { recursive: true });

    // Serialize per-repo to avoid fetch races with other callers.
    return await this.repoLocks.run(cacheKey, async () => {
      // Ensure bare repo exists.
      if (!(await this.isBareRepoValid(bareRepoPath))) {
        await fs.rm(bareRepoPath, { recursive: true, force: true });
        this.logger.info({ repoUrl, bareRepoPath }, 'readBranchFolder: cloning bare repo');
        try {
          await git(['clone', '--bare', authUrl, bareRepoPath]);
        } catch (err) {
          throw sanitizeGitError(err);
        }
        await git(['remote', 'set-url', 'origin', repoUrl], {
          cwd: bareRepoPath,
        });
      }

      // Fetch the branch. If the ref doesn't exist remotely, fall back to the
      // local ref (mirrors the `create()` behaviour for pushed-only branches).
      let treeRef = `refs/remotes/origin/${branch}`;
      try {
        await git(
          [
            'fetch',
            authUrl,
            `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
            `+refs/heads/${branch}:refs/heads/${branch}`,
          ],
          { cwd: bareRepoPath },
        );
      } catch (fetchErr) {
        this.logger.debug(
          { err: sanitizeGitError(fetchErr), branch },
          'readBranchFolder: remote fetch failed',
        );
        try {
          await git(['rev-parse', '--verify', `refs/heads/${branch}`], {
            cwd: bareRepoPath,
          });
          treeRef = `refs/heads/${branch}`;
        } catch {
          throw new Error(`Branch "${branch}" not found on remote or locally`);
        }
      }

      // Resolve spec layout. The user may point either at the spec root
      // (containing `briefs/`) or at the briefs folder itself. We detect
      // which case applies by listing the path and looking for a `briefs/`
      // entry.
      const lsTreeAt = async (refPath: string): Promise<string> => {
        try {
          const { stdout } = await git(['ls-tree', '--name-only', treeRef, `${refPath}/`], {
            cwd: bareRepoPath,
          });
          return stdout;
        } catch (err) {
          throw sanitizeGitError(err);
        }
      };

      const trimmedRelPath = relPath.replace(/\/+$/, '');
      const baseName = trimmedRelPath.split('/').pop() ?? trimmedRelPath;

      let specRootPath: string;
      let briefsPath: string;
      if (baseName === 'briefs') {
        specRootPath = trimmedRelPath.split('/').slice(0, -1).join('/') || trimmedRelPath;
        briefsPath = trimmedRelPath;
      } else {
        const rawAtRoot = await lsTreeAt(trimmedRelPath);
        const rootEntries = rawAtRoot
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        const hasBriefsSubdir = rootEntries.some((e) => e === `${trimmedRelPath}/briefs`);
        specRootPath = trimmedRelPath;
        briefsPath = hasBriefsSubdir ? `${trimmedRelPath}/briefs` : trimmedRelPath;
      }

      // List brief files under briefsPath.
      let rawNames: string;
      try {
        const { stdout } = await git(['ls-tree', '--name-only', treeRef, `${briefsPath}/`], {
          cwd: bareRepoPath,
        });
        rawNames = stdout;
      } catch (err) {
        throw sanitizeGitError(err);
      }

      const entries = rawNames
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((full) => ({ full, base: full.split('/').pop() ?? full }));

      const dirEntries = entries.filter((e) => !e.base.includes('.'));
      const folderFiles: Array<{ filename: string; content: string; contractContent?: string }> =
        [];
      for (const entry of dirEntries) {
        try {
          const [{ stdout: brief }, { stdout: contract }] = await Promise.all([
            git(['show', `${treeRef}:${entry.full}/brief.md`], {
              cwd: bareRepoPath,
              maxBuffer: 2 * 1024 * 1024,
            }),
            git(['show', `${treeRef}:${entry.full}/contract.yaml`], {
              cwd: bareRepoPath,
              maxBuffer: 2 * 1024 * 1024,
            }),
          ]);
          folderFiles.push({
            filename: entry.base,
            content: brief,
            contractContent: contract,
          });
        } catch {
          // Not a contract brief folder; fall back to the legacy flat-file path.
        }
      }
      if (folderFiles.length > 0) {
        const readDoc = async (docPath: string): Promise<string> => {
          try {
            const { stdout } = await git(['show', `${treeRef}:${docPath}`], {
              cwd: bareRepoPath,
              maxBuffer: 2 * 1024 * 1024,
            });
            return stdout.trim();
          } catch {
            return '';
          }
        };
        return {
          relPath: trimmedRelPath,
          files: folderFiles,
          purposeMd: await readDoc(`${specRootPath}/purpose.md`),
          designMd: await readDoc(`${specRootPath}/design.md`),
        };
      }

      // Top-level .md files only; exclude well-known non-brief docs that may
      // sit alongside briefs in flat layouts.
      const NON_BRIEF_DOCS = new Set(['purpose.md', 'design.md', 'context.md']);
      const mdEntries = entries.filter(
        (e) => e.base.endsWith('.md') && !NON_BRIEF_DOCS.has(e.base),
      );

      const files: Array<{ filename: string; content: string }> = [];
      for (const entry of mdEntries) {
        try {
          const { stdout } = await git(['show', `${treeRef}:${entry.full}`], {
            cwd: bareRepoPath,
            maxBuffer: 2 * 1024 * 1024,
          });
          files.push({ filename: entry.base, content: stdout });
        } catch (err) {
          this.logger.warn(
            { err: sanitizeGitError(err), entry: entry.full },
            'readBranchFolder: failed to read brief file',
          );
        }
      }

      const readDoc = async (docPath: string): Promise<string> => {
        try {
          const { stdout } = await git(['show', `${treeRef}:${docPath}`], {
            cwd: bareRepoPath,
            maxBuffer: 2 * 1024 * 1024,
          });
          return stdout.trim();
        } catch {
          return '';
        }
      };

      const purposeMd = await readDoc(`${specRootPath}/purpose.md`);
      const designMd = await readDoc(`${specRootPath}/design.md`);

      return { relPath: trimmedRelPath, files, purposeMd, designMd };
    });
  }

  // --- Private helpers ---

  /**
   * Resolve the authenticated push/fetch URL for a worktree.
   * Looks up the clean origin URL from the bare repo config and combines it with
   * the cached PAT. If no PAT is cached (e.g. public repo), returns the clean URL.
   * The credential is never stored in git config — only used per-command.
   */
  /**
   * Try merge-base with baseBranch, then origin/baseBranch.
   * Returns the resolved SHA or undefined if neither ref is available.
   */
  private async resolveMergeBase(
    worktreePath: string,
    baseBranch: string,
  ): Promise<string | undefined> {
    for (const ref of [baseBranch, `origin/${baseBranch}`]) {
      try {
        const { stdout } = await git(['merge-base', 'HEAD', ref], {
          cwd: worktreePath,
        });
        if (stdout.trim()) {
          return stdout.trim();
        }
      } catch {
        // ref not available in worktree — try next
      }
    }
    return undefined;
  }

  private async getAuthUrl(worktreePath: string): Promise<string> {
    const { stdout: commonDir } = await git(['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
    });
    const bareRepoPath = path.resolve(worktreePath, commonDir.trim());
    const { stdout: remoteUrl } = await git(['remote', 'get-url', 'origin'], {
      cwd: bareRepoPath,
    });
    const cleanUrl = remoteUrl.trim();
    const pat = this.patCache.get(bareRepoPath);
    if (!pat) {
      this.logger.warn(
        { bareRepoPath },
        'No PAT cached for this repo — git push/fetch will fail without credentials. ' +
          'Add a GitHub PAT to the profile.',
      );
    }
    return pat ? this.injectPat(cleanUrl, pat) : cleanUrl;
  }

  /** Inject a PAT into an https remote URL: https://host/... → https://x-access-token:PAT@host/...
   * Uses `x-access-token` as the username — required by GitHub fine-grained PATs and
   * compatible with classic PATs too.
   * Strips any existing userinfo first so stale credentials in the stored URL don't double-inject. */
  private injectPat(url: string, pat: string): string {
    return url.replace(/^https:\/\/([^@]*@)?/, `https://x-access-token:${pat}@`);
  }

  /** A bare repo is valid if it has been cloned (packed-refs or non-empty refs/). */
  private async isBareRepoValid(bareRepoPath: string): Promise<boolean> {
    try {
      await git(['rev-parse', '--git-dir'], { cwd: bareRepoPath });
      return true;
    } catch {
      return false;
    }
  }

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
}

export { truncateDiffAtFileBoundary } from './diff-utils.js';
