import { parsePorcelainChanges } from '../worktrees/source-adoption-git.js';

export interface WorkspaceCleanliness {
  /** Untracked paths `git status` reports in the container. */
  untracked: string[];
  /** Uncommitted changes to tracked paths. */
  changed: string[];
  /** Untracked paths hidden only by container-local excludes (not `.gitignore`). */
  hiddenByLocalExclude: string[];
}

type Exec = (
  command: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

// Daemon-owned container state that never belongs to a worker's change.
const DAEMON_OWNED = /(^|\/)(\.autopod|node_modules|\.serena|\.roslyn-codelens)(\/|$)/;
const MAX_HIDDEN = 200;
const GIT = ['git', '-c', 'core.fsmonitor=false', '-C', '/workspace'];

// Git reports collapsed untracked directories with a trailing slash.
const contains = (directory: string, path: string) =>
  directory.endsWith('/') && path.startsWith(directory);

/**
 * Observe the live container workspace while its worker can still act. Its
 * `.git/info/exclude` is container-local, so paths it alone hides are listed
 * separately: Autopod's host copy still sees them. Returns null when Git state
 * is unavailable; this is advisory and never a source-custody receipt.
 */
export async function probeWorkspaceCleanliness(
  exec: Exec,
  options: { includeLocallyExcluded: boolean },
): Promise<WorkspaceCleanliness | null> {
  const status = await exec(
    [...GIT, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    { timeout: 15_000 },
  );
  if (status.exitCode !== 0) return null;
  const parsed = parsePorcelainChanges(status.stdout);
  const untracked = parsed.untracked.filter((entry) => !DAEMON_OWNED.test(entry));
  const changed = parsed.changed;
  const hiddenByLocalExclude: string[] = [];
  if (options.includeLocallyExcluded) {
    // Honors only committed `.gitignore` files, like the host's clean check,
    // not `.git/info/exclude` or a container-global excludes file.
    const others = await exec(
      [
        ...GIT,
        'ls-files',
        '-z',
        '--others',
        '--directory',
        '--no-empty-directory',
        '--exclude-per-directory=.gitignore',
      ],
      { timeout: 15_000 },
    );
    if (others.exitCode === 0) {
      const visible = new Set(untracked);
      for (const entry of others.stdout.split('\0')) {
        if (!entry || visible.has(entry) || DAEMON_OWNED.test(entry)) continue;
        if (untracked.some((path) => contains(path, entry) || contains(entry, path))) continue;
        if (hiddenByLocalExclude.length < MAX_HIDDEN) hiddenByLocalExclude.push(entry);
      }
    }
  }
  return { untracked, changed, hiddenByLocalExclude };
}
