import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_ENV: Record<string, string> = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
};

const EXEC_OPTS = (cwd: string) => ({
  cwd,
  env: GIT_ENV,
  maxBuffer: 2 * 1024 * 1024,
});

/** Config files that are always worth including when present in the worktree */
const CONFIG_FILE_PATTERNS = [
  '.gitignore',
  'package.json',
  'tsconfig.json',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.eslintrc.json',
  'biome.json',
  'biome.jsonc',
  '.env.example',
];

/**
 * Structured snapshot of `git status --porcelain` split by what's actually
 * part of the PR. Untracked entries (`??`) are leftover worktree state from
 * build steps, tooling, or prior pod runs — they are NOT part of the
 * submission and the reviewer should not flag them.
 */
export interface GitStatusSummary {
  /** Tracked uncommitted entries (M/A/D/R/C). These ARE in the PR. */
  inPr: string[];
  /** Untracked entries (`??`). These are NOT part of the PR. */
  untrackedNotInPr: string[];
  /** Total porcelain lines before any capping. */
  totalCount: number;
  /** True when working tree is clean (no porcelain output). */
  clean: boolean;
}

export interface ReviewContext {
  /** Tier 0: auto-detected warnings (gitignore violations, contradictory ops) */
  annotations: string[];
  /** Tier 0: structured git status --porcelain summary */
  gitStatusSummary: GitStatusSummary;
  /** Tier 1: directory structure from git ls-files */
  fileTreeSummary: string;
  /** Tier 1: supplementary file contents for reviewer context */
  supplementaryFiles: Array<{ path: string; content: string; reason: string }>;
}

/**
 * Gathers enriched context from the worktree for the AI task reviewer.
 * Runs git commands and file reads in parallel for speed.
 */
export async function gatherReviewContext(
  worktreePath: string,
  diff: string,
  sinceCommit?: string,
): Promise<ReviewContext> {
  // Extract file paths from the diff for targeted analysis
  const diffFilePaths = parseDiffFilePaths(diff);

  const [gitignoreViolations, gitStatusSummary, fileTreeSummary, supplementaryFiles] =
    await Promise.all([
      detectGitignoreViolations(worktreePath, diffFilePaths),
      getGitStatusSummary(worktreePath),
      getFileTreeSummary(worktreePath),
      getSupplementaryFiles(worktreePath, diffFilePaths),
    ]);

  // Detect contradictory operations across commits (e.g., file added then "removed" but still present)
  const commitAnnotations = sinceCommit
    ? await detectContradictoryOps(worktreePath, sinceCommit)
    : [];

  return {
    annotations: [...gitignoreViolations, ...commitAnnotations],
    gitStatusSummary,
    fileTreeSummary,
    supplementaryFiles,
  };
}

// ── Diff parsing ──────────────────────────────────────────────────────────────

/** Extract file paths from unified diff headers (--- a/path and +++ b/path) */
export function parseDiffFilePaths(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    // Match +++ b/path or --- a/path (skip /dev/null)
    const match = line.match(/^(?:\+\+\+|---) [ab]\/(.+)$/);
    if (match && match[1] !== '/dev/null') {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

// ── Tier 0: Gitignore violation detection ─────────────────────────────────────

/**
 * Detects files that are tracked in git but match a .gitignore pattern.
 * This catches the common bug where an agent adds a .gitignore entry
 * but forgets to `git rm --cached` the file.
 */
async function detectGitignoreViolations(
  worktreePath: string,
  diffFilePaths: string[],
): Promise<string[]> {
  if (diffFilePaths.length === 0) return [];

  const annotations: string[] = [];

  try {
    // Ask git which of the diff's files are currently tracked
    const { stdout: trackedOutput } = await execFileAsync(
      'git',
      ['ls-files', '--', ...diffFilePaths],
      EXEC_OPTS(worktreePath),
    );
    const trackedFiles = new Set(trackedOutput.trim().split('\n').filter(Boolean));
    if (trackedFiles.size === 0) return [];

    // Check which tracked files would be ignored by .gitignore
    // --no-index is needed because git check-ignore skips tracked files by default
    const trackedList = [...trackedFiles];
    try {
      const { stdout: ignoredOutput } = await execFileAsync(
        'git',
        ['check-ignore', '--no-index', '--', ...trackedList],
        EXEC_OPTS(worktreePath),
      );
      const ignoredFiles = ignoredOutput.trim().split('\n').filter(Boolean);
      for (const file of ignoredFiles) {
        annotations.push(
          `⚠ GITIGNORE VIOLATION: \`${file}\` is tracked in git but matches a .gitignore pattern. The file will persist in the repository despite the .gitignore entry. Likely missing \`git rm --cached "${file}"\`.`,
        );
      }
    } catch {
      // git check-ignore exits 1 when no files match — that's fine
    }
  } catch {
    // Non-fatal: if git commands fail, skip this check
  }

  return annotations;
}

// ── Tier 0: Git status snapshot ───────────────────────────────────────────────

/**
 * Splits `git status --porcelain` into two buckets:
 * - `inPr`: tracked uncommitted entries (M/A/D/R/C) — these ARE part of the PR.
 * - `untrackedNotInPr`: `??` entries — leftover worktree state, NOT part of the PR.
 *
 * The split exists so the reviewer prompt can render the two with explicit
 * labels. Otherwise the agentic reviewer reads untracked file paths out of
 * the status block and starts citing them as if they were submitted code.
 */
async function getGitStatusSummary(worktreePath: string): Promise<GitStatusSummary> {
  const empty: GitStatusSummary = {
    inPr: [],
    untrackedNotInPr: [],
    totalCount: 0,
    clean: true,
  };

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      EXEC_OPTS(worktreePath),
    );
    if (!stdout.trim()) return empty;

    const lines = stdout.trim().split('\n');
    const inPr: string[] = [];
    const untrackedNotInPr: string[] = [];

    for (const line of lines) {
      // Porcelain v1: columns 0-1 are the status code. `??` marks untracked.
      if (line.startsWith('??')) {
        untrackedNotInPr.push(line);
      } else {
        inPr.push(line);
      }
    }

    return {
      inPr,
      untrackedNotInPr,
      totalCount: lines.length,
      clean: false,
    };
  } catch {
    return empty;
  }
}

// ── Tier 1: File tree summary ─────────────────────────────────────────────────

async function getFileTreeSummary(worktreePath: string, maxBytes = 2_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], EXEC_OPTS(worktreePath));
    if (!stdout.trim()) return '';

    const files = stdout.trim().split('\n');
    const tree = buildTreeSummary(files);

    // Truncate if needed
    return tree.length > maxBytes ? `${tree.slice(0, maxBytes)}\n... (truncated)` : tree;
  } catch {
    return '';
  }
}

/**
 * Builds a compact directory tree with file counts per directory.
 * Example: `src/ (42 files)`, `src/validation/ (5 files)`
 */
function buildTreeSummary(files: string[]): string {
  const dirCounts = new Map<string, number>();

  for (const file of files) {
    const dir = path.dirname(file);
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }

  const lines: string[] = [`${files.length} files total`];
  const sorted = [...dirCounts.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [dir, count] of sorted) {
    const depth = dir === '.' ? 0 : dir.split('/').length;
    const indent = '  '.repeat(depth);
    const name = dir === '.' ? '.' : path.basename(dir);
    lines.push(`${indent}${name}/ (${count} file${count > 1 ? 's' : ''})`);
  }

  return lines.join('\n');
}

// ── Tier 1: Supplementary file contents ───────────────────────────────────────

async function getSupplementaryFiles(
  worktreePath: string,
  diffFilePaths: string[],
  maxTotalBytes = 30_000,
  maxFileBytes = 10_000,
): Promise<Array<{ path: string; content: string; reason: string }>> {
  const result: Array<{ path: string; content: string; reason: string }> = [];
  let totalBytes = 0;

  // Priority 1: .gitignore files (root + nested)
  const gitignoreFiles = await findGitignoreFiles(worktreePath);
  for (const relPath of gitignoreFiles) {
    if (totalBytes >= maxTotalBytes) break;
    const content = await readFileCapped(worktreePath, relPath, maxFileBytes);
    if (content) {
      totalBytes += content.length;
      result.push({
        path: relPath,
        content,
        reason: 'gitignore rules affect which files should be tracked',
      });
    }
  }

  // Priority 2: Config files that exist in the worktree and are touched by the diff
  const configsInDiff = diffFilePaths.filter((p) =>
    CONFIG_FILE_PATTERNS.some((pattern) => path.basename(p) === pattern || p.endsWith(pattern)),
  );
  for (const relPath of configsInDiff) {
    if (totalBytes >= maxTotalBytes) break;
    if (result.some((r) => r.path === relPath)) continue; // skip dupes
    const content = await readFileCapped(worktreePath, relPath, maxFileBytes);
    if (content) {
      totalBytes += content.length;
      result.push({ path: relPath, content, reason: 'config file modified in this diff' });
    }
  }

  // Priority 3: Root config files not in the diff (for context)
  for (const pattern of CONFIG_FILE_PATTERNS) {
    if (totalBytes >= maxTotalBytes) break;
    if (result.some((r) => r.path === pattern)) continue;
    const content = await readFileCapped(worktreePath, pattern, maxFileBytes);
    if (content) {
      totalBytes += content.length;
      result.push({ path: pattern, content, reason: 'root config file (context)' });
    }
  }

  return result;
}

async function findGitignoreFiles(worktreePath: string): Promise<string[]> {
  try {
    // Use git ls-files to find tracked .gitignore files
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--', '*.gitignore', '.gitignore'],
      EXEC_OPTS(worktreePath),
    );
    const files = stdout.trim().split('\n').filter(Boolean);

    // Also check for untracked root .gitignore (common in new repos)
    if (!files.includes('.gitignore')) {
      try {
        await fs.access(path.join(worktreePath, '.gitignore'));
        files.unshift('.gitignore');
      } catch {
        // doesn't exist, fine
      }
    }

    return files;
  } catch {
    return [];
  }
}

async function readFileCapped(
  worktreePath: string,
  relPath: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    // Prevent path traversal
    const resolved = path.resolve(worktreePath, relPath);
    if (!resolved.startsWith(path.resolve(worktreePath))) return null;

    const content = await fs.readFile(resolved, 'utf-8');
    return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n... (truncated)` : content;
  } catch {
    return null;
  }
}

// ── Tier 0: Contradictory commit operations ───────────────────────────────────

/**
 * Detects contradictory file operations across commits, e.g.:
 * - File added in commit A, .gitignore updated in commit B, but file still tracked
 * - File deleted then re-added
 */
async function detectContradictoryOps(
  worktreePath: string,
  sinceCommit: string,
): Promise<string[]> {
  const annotations: string[] = [];

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--name-status', '--format=%H %s', `${sinceCommit}..HEAD`],
      EXEC_OPTS(worktreePath),
    );

    if (!stdout.trim()) return [];

    // Parse commit log into per-file operation history
    const fileOps = new Map<string, Array<{ op: string; commit: string; subject: string }>>();
    let currentCommit = '';
    let currentSubject = '';

    for (const line of stdout.split('\n')) {
      // Commit header line: <sha> <subject>
      const commitMatch = line.match(/^([0-9a-f]{40})\s+(.*)$/);
      if (commitMatch) {
        currentCommit = commitMatch[1].slice(0, 8);
        currentSubject = commitMatch[2];
        continue;
      }

      // File operation line: A/M/D/R\t<path>
      const opMatch = line.match(/^([AMDRC])\t(.+)$/);
      if (opMatch && currentCommit) {
        const [, op, filePath] = opMatch;
        if (!fileOps.has(filePath)) fileOps.set(filePath, []);
        fileOps.get(filePath)?.push({ op, commit: currentCommit, subject: currentSubject });
      }
    }

    // Flag files with contradictory operations
    for (const [filePath, ops] of fileOps) {
      if (ops.length < 2) continue;

      const opTypes = ops.map((o) => o.op);
      const hasAdd = opTypes.includes('A');
      const hasDelete = opTypes.includes('D');

      // File was both added and deleted across commits
      if (hasAdd && hasDelete) {
        const addOps = ops.filter((o) => o.op === 'A');
        const deleteOps = ops.filter((o) => o.op === 'D');
        annotations.push(
          `NOTE: \`${filePath}\` was added (${addOps.map((o) => o.commit).join(', ')}) and deleted (${deleteOps.map((o) => o.commit).join(', ')}) across separate commits. Verify the file's final state is intentional.`,
        );
      }
    }

    // Check for .gitignore changes alongside file additions
    const gitignoreOps = fileOps.get('.gitignore') ?? [];
    if (gitignoreOps.length > 0) {
      // There were .gitignore changes — check if any added files should now be ignored
      const addedFiles = [...fileOps.entries()]
        .filter(([, ops]) => ops.some((o) => o.op === 'A'))
        .map(([filePath]) => filePath)
        .filter((f) => f !== '.gitignore');

      if (addedFiles.length > 0) {
        try {
          const { stdout: ignoredOutput } = await execFileAsync(
            'git',
            ['check-ignore', '--no-index', '--', ...addedFiles],
            EXEC_OPTS(worktreePath),
          );
          const ignoredButAdded = ignoredOutput.trim().split('\n').filter(Boolean);
          for (const file of ignoredButAdded) {
            // Only annotate if not already caught by gitignore violation detector
            annotations.push(
              `NOTE: \`${file}\` was added to git in this branch AND matches updated .gitignore patterns. The .gitignore entry will not retroactively remove the tracked file.`,
            );
          }
        } catch {
          // git check-ignore exits 1 when no files match
        }
      }
    }
  } catch {
    // Non-fatal
  }

  return annotations;
}
