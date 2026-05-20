import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import {
  DIFF_EXCLUDE_PATHSPECS,
  stripModeOnlyChanges,
  truncateDiffAtFileBoundary,
} from '../worktrees/diff-utils.js';

const execFileAsync = promisify(execFile);

const WORKSPACE_DIR = '/workspace';
const MAX_PREVIEW_FILES = 50;
const MAX_PREVIEW_FILE_BYTES = 128 * 1024;
const MAX_PREVIEW_TOTAL_DIFF_BYTES = 300 * 1024;
const MAX_COMMIT_GROUPS = 50;
const MAX_COMMIT_DIFF_BYTES = 80 * 1024;
const MAX_UNCOMMITTED_DIFF_BYTES = 120 * 1024;

export type DiffSource = 'container' | 'worktree' | 'none';

export interface PodDiffSlice {
  containerId: string | null;
  worktreePath: string | null;
  startCommitSha: string | null;
}

export interface ComputePodDiffOpts {
  pod: PodDiffSlice;
  defaultBranch: string;
  containerManager?: ContainerManager;
  worktreeManager?: WorktreeManager;
  maxLength?: number;
  logger?: Logger;
}

export interface PodDiffResult {
  diff: string;
  source: DiffSource;
}

export interface PodDiffPreviewFile {
  path: string;
  status: 'added';
  diff: string;
  binary?: boolean;
  truncated?: boolean;
  note?: string;
}

export interface PodUntrackedPreviewResult {
  files: PodDiffPreviewFile[];
  source: DiffSource;
}

export interface PodUncommittedDiffResult {
  diff: string;
  source: DiffSource;
}

export interface PodCommitDiff {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorDate: string;
  diff: string;
}

export interface PodCommitDiffsResult {
  commits: PodCommitDiff[];
  source: DiffSource;
  unavailableReason?: string;
}

/**
 * Compute the cumulative diff of an agent's work since `startCommitSha`.
 *
 * Strategy:
 *   1. If the container is running, exec `git diff <startCommitSha>` inside it.
 *      The container holds the agent's commits in /workspace/.git long before
 *      `syncWorkspaceBack()` mirrors them to the host, so the in-container view
 *      is always fresh — host worktree is not.
 *   2. Fall back to the host worktree only when the container is gone or the
 *      in-container exec fails.
 *
 * Mirrors the strategy used by /pods/:id/diff (routes/diff.ts) so live tools
 * and the desktop diff view see the same bytes.
 */
export async function computePodDiff(opts: ComputePodDiffOpts): Promise<PodDiffResult> {
  const { pod, defaultBranch, containerManager, worktreeManager, maxLength, logger } = opts;

  if (pod.containerId && containerManager) {
    const containerDiff = await tryContainerDiff(
      containerManager,
      pod.containerId,
      pod.startCommitSha,
      defaultBranch,
      logger,
    );
    if (containerDiff !== null) {
      return {
        diff: finalizeDiff(containerDiff, maxLength),
        source: 'container',
      };
    }
  }

  if (pod.worktreePath && worktreeManager) {
    const worktreeDiff = await worktreeManager
      .getDiff(pod.worktreePath, defaultBranch, maxLength, pod.startCommitSha ?? undefined)
      .catch((err) => {
        logger?.warn({ err }, 'computePodDiff: host worktree fallback failed');
        return '';
      });
    return { diff: worktreeDiff, source: worktreeDiff ? 'worktree' : 'none' };
  }

  return { diff: '', source: 'none' };
}

export async function computePodUncommittedDiff(
  opts: ComputePodDiffOpts,
): Promise<PodUncommittedDiffResult> {
  const { pod, containerManager, logger } = opts;

  if (pod.containerId && containerManager) {
    const diff = await tryContainerGit(containerManager, pod.containerId, [
      'diff',
      '--no-color',
      'HEAD',
      ...DIFF_EXCLUDE_PATHSPECS,
    ]).catch((err) => {
      logger?.warn({ err }, 'computePodUncommittedDiff: in-container git diff threw');
      return null;
    });
    if (diff?.exitCode === 0) {
      return { diff: finalizeDiff(diff.stdout, MAX_UNCOMMITTED_DIFF_BYTES), source: 'container' };
    }
    if (diff) {
      logger?.warn(
        { exitCode: diff.exitCode, stderr: diff.stderr.slice(0, 500) },
        'computePodUncommittedDiff: in-container git diff failed',
      );
    }
  }

  if (pod.worktreePath) {
    const diff = await tryHostGit(pod.worktreePath, [
      'diff',
      '--no-color',
      'HEAD',
      ...DIFF_EXCLUDE_PATHSPECS,
    ]).catch((err) => {
      logger?.warn({ err }, 'computePodUncommittedDiff: host git diff failed');
      return null;
    });
    if (diff !== null) {
      return { diff: finalizeDiff(diff, MAX_UNCOMMITTED_DIFF_BYTES), source: 'worktree' };
    }
  }

  return { diff: '', source: 'none' };
}

export async function computePodUntrackedPreview(
  opts: ComputePodDiffOpts,
): Promise<PodUntrackedPreviewResult> {
  const { pod, containerManager, logger } = opts;

  if (pod.containerId && containerManager) {
    const files = await tryContainerUntrackedPreview(containerManager, pod.containerId, logger);
    if (files !== null) return { files, source: 'container' };
  }

  if (pod.worktreePath) {
    const files = await tryHostUntrackedPreview(pod.worktreePath, logger);
    if (files !== null) return { files, source: 'worktree' };
  }

  return { files: [], source: 'none' };
}

export async function computePodCommitDiffs(
  opts: ComputePodDiffOpts,
): Promise<PodCommitDiffsResult> {
  const { pod, containerManager, logger } = opts;

  if (!pod.startCommitSha) {
    return {
      commits: [],
      source: 'none',
      unavailableReason:
        'startCommitSha unavailable; commit grouping would require moving-base fallback',
    };
  }

  if (pod.containerId && containerManager) {
    const result = await tryContainerCommitDiffs(
      containerManager,
      pod.containerId,
      pod.startCommitSha,
      logger,
    );
    if (result !== null) return { commits: result, source: 'container' };
  }

  if (pod.worktreePath) {
    const result = await tryHostCommitDiffs(pod.worktreePath, pod.startCommitSha, logger);
    if (result !== null) return { commits: result, source: 'worktree' };
  }

  return {
    commits: [],
    source: 'none',
    unavailableReason: 'commit grouping unavailable from container and host worktree',
  };
}

async function tryContainerDiff(
  cm: ContainerManager,
  containerId: string,
  startCommitSha: string | null,
  defaultBranch: string,
  logger?: Logger,
): Promise<string | null> {
  try {
    const base = await resolveContainerBase(cm, containerId, startCommitSha, defaultBranch);
    if (!base) return null;

    // Single-ref `git diff <base>` folds committed + uncommitted into one net
    // delta — same approach as LocalWorktreeManager.getDiff. See the inline
    // comment there for why double-ref `git diff base HEAD` would double-count
    // files committed-then-modified.
    const result = await cm.execInContainer(
      containerId,
      ['git', 'diff', '--no-color', base, ...DIFF_EXCLUDE_PATHSPECS],
      { cwd: WORKSPACE_DIR, timeout: 30_000 },
    );
    if (result.exitCode !== 0) {
      logger?.warn(
        { exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
        'computePodDiff: in-container git diff failed',
      );
      return null;
    }
    return result.stdout;
  } catch (err) {
    logger?.warn({ err }, 'computePodDiff: in-container git diff threw');
    return null;
  }
}

async function resolveContainerBase(
  cm: ContainerManager,
  containerId: string,
  startCommitSha: string | null,
  defaultBranch: string,
): Promise<string | undefined> {
  if (startCommitSha) return startCommitSha;
  for (const ref of [defaultBranch, `origin/${defaultBranch}`]) {
    try {
      const result = await cm.execInContainer(containerId, ['git', 'merge-base', 'HEAD', ref], {
        cwd: WORKSPACE_DIR,
        timeout: 10_000,
      });
      if (result.exitCode === 0 && result.stdout.trim()) {
        return result.stdout.trim();
      }
    } catch {
      // Try next ref form
    }
  }
  return undefined;
}

function finalizeDiff(rawDiff: string, maxLength?: number): string {
  const stripped = stripModeOnlyChanges(rawDiff);
  if (maxLength === undefined) return stripped;
  return truncateDiffAtFileBoundary(stripped, maxLength);
}

async function tryContainerGit(
  cm: ContainerManager,
  containerId: string,
  args: string[],
  timeout = 30_000,
) {
  return cm.execInContainer(containerId, ['git', ...args], {
    cwd: WORKSPACE_DIR,
    timeout,
  });
}

async function tryHostGit(worktreePath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: worktreePath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function parseNulList(raw: string): string[] {
  return raw.split('\0').filter(Boolean);
}

function untrackedListArgs(): string[] {
  return ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ...DIFF_EXCLUDE_PATHSPECS];
}

async function tryContainerUntrackedPreview(
  cm: ContainerManager,
  containerId: string,
  logger?: Logger,
): Promise<PodDiffPreviewFile[] | null> {
  const listed = await tryContainerGit(cm, containerId, untrackedListArgs(), 15_000).catch(
    (err) => {
      logger?.warn({ err }, 'computePodUntrackedPreview: in-container ls-files threw');
      return null;
    },
  );
  if (!listed || listed.exitCode !== 0) return null;

  const paths = parseNulList(listed.stdout).slice(0, MAX_PREVIEW_FILES);
  const files: PodDiffPreviewFile[] = [];
  let totalBytes = 0;

  for (const filePath of paths) {
    const sizeResult = await cm
      .execInContainer(containerId, ['stat', '-c', '%s', '--', filePath], {
        cwd: WORKSPACE_DIR,
        timeout: 5_000,
      })
      .catch(() => null);
    const size = Number.parseInt(sizeResult?.stdout.trim() ?? '', 10);
    const file = await buildUntrackedPreviewFile(
      filePath,
      Number.isFinite(size) ? size : undefined,
      async () => {
        const diff = await cm.execInContainer(
          containerId,
          ['git', 'diff', '--no-index', '--no-color', '--', '/dev/null', filePath],
          { cwd: WORKSPACE_DIR, timeout: 10_000 },
        );
        return diff.exitCode === 0 || diff.exitCode === 1 ? diff.stdout : '';
      },
      totalBytes,
    );
    totalBytes += file.diff.length;
    files.push(file);
  }

  return files;
}

async function tryHostUntrackedPreview(
  worktreePath: string,
  logger?: Logger,
): Promise<PodDiffPreviewFile[] | null> {
  const listed = await tryHostGit(worktreePath, untrackedListArgs()).catch((err) => {
    logger?.warn({ err }, 'computePodUntrackedPreview: host ls-files failed');
    return null;
  });
  if (listed === null) return null;

  const paths = parseNulList(listed).slice(0, MAX_PREVIEW_FILES);
  const files: PodDiffPreviewFile[] = [];
  let totalBytes = 0;

  for (const filePath of paths) {
    const stat = await fs.stat(`${worktreePath}/${filePath}`).catch(() => null);
    const file = await buildUntrackedPreviewFile(
      filePath,
      stat?.size,
      async () => {
        const { stdout } = await execFileAsync(
          'git',
          ['diff', '--no-index', '--no-color', '--', '/dev/null', filePath],
          {
            cwd: worktreePath,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
            maxBuffer: 2 * 1024 * 1024,
          },
        ).catch((err: unknown) => {
          const maybe = err as { stdout?: string; code?: number };
          if (maybe.code === 1 && typeof maybe.stdout === 'string') return { stdout: maybe.stdout };
          return { stdout: '' };
        });
        return stdout;
      },
      totalBytes,
    );
    totalBytes += file.diff.length;
    files.push(file);
  }

  return files;
}

async function buildUntrackedPreviewFile(
  filePath: string,
  size: number | undefined,
  readDiff: () => Promise<string>,
  currentTotalBytes: number,
): Promise<PodDiffPreviewFile> {
  if (size !== undefined && size > MAX_PREVIEW_FILE_BYTES) {
    return omittedPreviewFile(
      filePath,
      `Untracked file omitted from preview (${size} bytes exceeds ${MAX_PREVIEW_FILE_BYTES} byte cap).`,
      true,
    );
  }
  if (currentTotalBytes >= MAX_PREVIEW_TOTAL_DIFF_BYTES) {
    return omittedPreviewFile(
      filePath,
      `Untracked file omitted from preview (total preview exceeded ${MAX_PREVIEW_TOTAL_DIFF_BYTES} bytes).`,
      true,
    );
  }

  const rawDiff = await readDiff().catch(() => '');
  const binary = rawDiff.includes('Binary files ');
  const diff =
    rawDiff.trim().length > 0
      ? finalizeDiff(rawDiff, MAX_PREVIEW_FILE_BYTES)
      : synthesizePreviewHeader(filePath);
  const truncated = diff.includes('DIFF TRUNCATED');

  return {
    path: filePath,
    status: 'added',
    diff,
    ...(binary ? { binary: true, note: 'Binary file; content preview omitted.' } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function omittedPreviewFile(
  filePath: string,
  note: string,
  truncated: boolean,
): PodDiffPreviewFile {
  return {
    path: filePath,
    status: 'added',
    diff: synthesizePreviewHeader(filePath),
    truncated,
    note,
  };
}

function synthesizePreviewHeader(filePath: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    '',
  ].join('\n');
}

async function tryContainerCommitDiffs(
  cm: ContainerManager,
  containerId: string,
  startCommitSha: string,
  logger?: Logger,
): Promise<PodCommitDiff[] | null> {
  const commits = await readContainerCommitList(cm, containerId, startCommitSha, logger);
  if (commits === null) return null;

  const enriched: PodCommitDiff[] = [];
  for (const commit of commits) {
    const diff = await tryContainerGit(
      cm,
      containerId,
      [
        'show',
        '--format=',
        '--patch',
        '--no-color',
        commit.sha,
        '--',
        '.',
        ...DIFF_EXCLUDE_PATHSPECS,
      ],
      20_000,
    ).catch(() => null);
    enriched.push({
      ...commit,
      diff: diff?.exitCode === 0 ? finalizeDiff(diff.stdout, MAX_COMMIT_DIFF_BYTES) : '',
    });
  }
  return enriched;
}

async function readContainerCommitList(
  cm: ContainerManager,
  containerId: string,
  startCommitSha: string,
  logger?: Logger,
): Promise<Omit<PodCommitDiff, 'diff'>[] | null> {
  const result = await tryContainerGit(
    cm,
    containerId,
    commitListArgs(startCommitSha),
    15_000,
  ).catch((err) => {
    logger?.warn({ err }, 'computePodCommitDiffs: in-container git log threw');
    return null;
  });
  if (!result || result.exitCode !== 0) return null;
  return parseCommitList(result.stdout);
}

async function tryHostCommitDiffs(
  worktreePath: string,
  startCommitSha: string,
  logger?: Logger,
): Promise<PodCommitDiff[] | null> {
  const raw = await tryHostGit(worktreePath, commitListArgs(startCommitSha)).catch((err) => {
    logger?.warn({ err }, 'computePodCommitDiffs: host git log failed');
    return null;
  });
  if (raw === null) return null;

  const commits = parseCommitList(raw);
  const enriched: PodCommitDiff[] = [];
  for (const commit of commits) {
    const rawDiff = await tryHostGit(worktreePath, [
      'show',
      '--format=',
      '--patch',
      '--no-color',
      commit.sha,
      '--',
      '.',
      ...DIFF_EXCLUDE_PATHSPECS,
    ]).catch(() => '');
    enriched.push({
      ...commit,
      diff: finalizeDiff(rawDiff, MAX_COMMIT_DIFF_BYTES),
    });
  }
  return enriched;
}

function commitListArgs(startCommitSha: string): string[] {
  return [
    'log',
    `${startCommitSha}..HEAD`,
    `--max-count=${MAX_COMMIT_GROUPS}`,
    '--format=%H%x00%h%x00%aI%x00%s%x00%b%x1e',
  ];
}

function parseCommitList(raw: string): Omit<PodCommitDiff, 'diff'>[] {
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .flatMap((record) => {
      const fields = record.split('\0');
      const [sha, shortSha, authorDate, subject, ...bodyParts] = fields;
      if (!sha || !shortSha || !authorDate || !subject) return [];
      return [
        {
          sha,
          shortSha,
          authorDate,
          subject,
          body: bodyParts.join('\0').trim(),
        },
      ];
    });
}

export interface DiffScopeStats {
  filesReviewed: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Compute coarse +/- and file counts from a unified diff. Used to echo scope back to agents. */
export function summarizeDiff(diff: string): DiffScopeStats {
  if (!diff.trim()) return { filesReviewed: 0, linesAdded: 0, linesRemoved: 0 };
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }
  const filesReviewed = (diff.match(/^diff --git /gm) ?? []).length;
  return { filesReviewed, linesAdded, linesRemoved };
}
