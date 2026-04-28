import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Default per-file size limit. Files larger than this are skipped. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** Bytes to read when sniffing for binary content. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Defensive skip-list — these dirs may slip past .gitignore in some repos. */
const SKIP_DIRS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  'vendor',
  'target',
  '.gradle',
  '.cache',
];

export interface ScanFile {
  /** Repo-relative path. */
  path: string;
  /** UTF-8 file contents (already size-checked, already binary-filtered). */
  content: string;
  sizeBytes: number;
}

export interface FileWalkerOptions {
  /** Override max file size in bytes. */
  maxBytes?: number;
}

/**
 * `git ls-files` for the repo at `workdir`. Returns repo-relative paths.
 * Honors .gitignore by virtue of using git itself.
 */
export async function listTrackedFiles(workdir: string): Promise<string[]> {
  const out = await runGit(workdir, ['ls-files']);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !shouldSkipDir(p));
}

/**
 * Return repo-relative paths of files changed in `git diff baseRef...HEAD`.
 * Empty array is a valid return (no diff yet — first pod on fresh main).
 */
export async function listDiffFiles(workdir: string, baseRef: string): Promise<string[]> {
  const out = await runGit(workdir, ['diff', '--name-only', `${baseRef}...HEAD`]);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !shouldSkipDir(p));
}

/**
 * Probe a candidate base ref against the local repo. Returns the first ref
 * that resolves to a commit, or null if none do.
 *
 * Tried in order: the candidate as-given, the same name with/without an
 * `origin/` prefix, then `origin/main`, `main`, `origin/master`, `master`.
 *
 * Used at the push checkpoint where `origin/<feature-branch>` may not yet
 * exist locally (e.g. a fix-pod whose parent branch hasn't been pushed).
 */
export async function resolveBaseRef(workdir: string, candidate: string): Promise<string | null> {
  const stripped = candidate.replace(/^origin\//, '');
  const tries = [
    candidate,
    stripped,
    `origin/${stripped}`,
    'origin/main',
    'main',
    'origin/master',
    'master',
  ];
  const seen = new Set<string>();
  for (const ref of tries) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    try {
      await runGit(workdir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return ref;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Resolve a glob list (default DEFAULT_ALWAYS_SCAN_PATHS) against the repo.
 * Returns repo-relative paths that exist and pass the skip filter.
 *
 * Globs we support: `*`, `**`, and exact path. Brace expansion is not
 * supported (we don't need it for the default list).
 */
export async function listAlwaysScan(workdir: string, globs: readonly string[]): Promise<string[]> {
  const tracked = await listTrackedFiles(workdir);
  const matchers = globs.map(globToRegex);
  const matched = new Set<string>();
  for (const file of tracked) {
    if (matchers.some((re) => re.test(file))) matched.add(file);
  }
  return [...matched];
}

/**
 * Read each path and return a `ScanFile`, applying size and binary filters.
 * Returns `{ files, skipped }` so callers can report skip counts.
 */
export async function loadScanFiles(
  workdir: string,
  paths: string[],
  options: FileWalkerOptions = {},
): Promise<{ files: ScanFile[]; skipped: number }> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const files: ScanFile[] = [];
  let skipped = 0;

  for (const relPath of paths) {
    const absPath = path.join(workdir, relPath);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(absPath);
    } catch {
      skipped += 1;
      continue;
    }
    if (!st.isFile()) {
      skipped += 1;
      continue;
    }
    if (st.size > maxBytes) {
      skipped += 1;
      continue;
    }
    let buf: Buffer;
    try {
      buf = await readFile(absPath);
    } catch {
      skipped += 1;
      continue;
    }
    if (looksBinary(buf)) {
      skipped += 1;
      continue;
    }
    files.push({
      path: relPath,
      content: buf.toString('utf-8'),
      sizeBytes: st.size,
    });
  }

  return { files, skipped };
}

function shouldSkipDir(relPath: string): boolean {
  const parts = relPath.split('/');
  return parts.some((p) => SKIP_DIRS.includes(p));
}

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Translate a simple glob pattern to a regex. Supports `*` (single segment)
 * and `**` (any number of segments). Anchored to full string.
 */
export function globToRegex(glob: string): RegExp {
  let i = 0;
  let out = '^';
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      // `**/x` matches zero or more path segments before x.
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '.' || ch === '+' || ch === '(' || ch === ')' || ch === '|') {
      out += `\\${ch}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

/** Run `git` in `workdir`, return stdout. Throws on non-zero exit. */
function runGit(workdir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: workdir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}
