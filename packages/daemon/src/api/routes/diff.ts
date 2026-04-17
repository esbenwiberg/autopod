import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { ProfileStore } from '../../profiles/index.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';

const execFileAsync = promisify(execFile);

interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  diff: string;
}

interface DiffResponse {
  files: DiffFile[];
  stats: { added: number; removed: number; changed: number };
}

export function diffRoutes(
  app: FastifyInstance,
  podManager: PodManager,
  containerManagerFactory: ContainerManagerFactory,
  profileStore: ProfileStore,
): void {
  // GET /pods/:podId/diff — get unified diff for a pod
  app.get('/pods/:podId/diff', async (request) => {
    const { podId } = request.params as { podId: string };
    const pod = podManager.getSession(podId);

    const baseBranch = pod.baseBranch ?? getBaseBranch(profileStore, pod.profileName);
    const sinceCommit = pod.startCommitSha ?? undefined;

    // Strategy 1: Try container-based diff (works when container is running)
    let rawDiff = '';
    if (pod.containerId) {
      rawDiff = await tryContainerDiff(
        containerManagerFactory,
        pod.containerId,
        pod.executionTarget,
        baseBranch,
        sinceCommit,
      );
    }

    // Strategy 2: Fall back to host-side worktree diff (works after container stops)
    if (!rawDiff.trim() && pod.worktreePath) {
      rawDiff = await tryWorktreeDiff(pod.worktreePath, baseBranch, sinceCommit);
    }

    if (!rawDiff.trim()) {
      return { files: [], stats: { added: 0, removed: 0, changed: 0 } } satisfies DiffResponse;
    }

    // Parse the unified diff into structured files
    const files = parseDiff(rawDiff);
    const stats = {
      added: files.reduce((sum, f) => sum + countLines(f.diff, '+'), 0),
      removed: files.reduce((sum, f) => sum + countLines(f.diff, '-'), 0),
      changed: files.length,
    };

    return { files, stats } satisfies DiffResponse;
  });
}

// MARK: - Diff strategies

async function tryContainerDiff(
  containerManagerFactory: ContainerManagerFactory,
  containerId: string,
  executionTarget: string,
  baseBranch: string,
  sinceCommit?: string,
): Promise<string> {
  const cm = containerManagerFactory.get(executionTarget);
  const workDir = '/workspace';

  try {
    let base: string | undefined;

    if (sinceCommit) {
      // Scope to only the agent's commits from this pod
      base = sinceCommit;
    } else {
      // Fall back to merge-base for pods without startCommitSha
      const mergeBaseResult = await cm.execInContainer(
        containerId,
        ['git', 'merge-base', 'HEAD', baseBranch],
        { cwd: workDir, timeout: 10_000 },
      );
      if (mergeBaseResult.exitCode === 0 && mergeBaseResult.stdout.trim()) {
        base = mergeBaseResult.stdout.trim();
      }
    }

    if (!base) {
      // baseBranch didn't resolve — try origin/${baseBranch} (bare repo remote-tracking ref)
      const fallbackResult = await cm.execInContainer(
        containerId,
        ['git', 'merge-base', 'HEAD', `origin/${baseBranch}`],
        { cwd: workDir, timeout: 10_000 },
      );
      if (fallbackResult.exitCode === 0 && fallbackResult.stdout.trim()) {
        base = fallbackResult.stdout.trim();
      }
    }

    if (base) {
      const result = await cm.execInContainer(
        containerId,
        ['git', 'diff', base, 'HEAD', '--no-color'],
        { cwd: workDir, timeout: 30_000 },
      );
      if (result.exitCode === 0 && result.stdout.trim()) {
        return result.stdout;
      }
    }
  } catch {
    // Container may be stopped — fall through
  }

  // Fallback: uncommitted changes
  try {
    const result = await cm.execInContainer(containerId, ['git', 'diff', 'HEAD', '--no-color'], {
      cwd: workDir,
      timeout: 30_000,
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout;
    }
  } catch {
    // Container unavailable
  }

  return '';
}

async function tryWorktreeDiff(
  worktreePath: string,
  baseBranch: string,
  sinceCommit?: string,
): Promise<string> {
  try {
    // Verify the worktree still exists on disk
    await access(worktreePath);
  } catch {
    return '';
  }

  const bufOpts = { cwd: worktreePath, maxBuffer: 2 * 1024 * 1024 };

  // If we have a sinceCommit, use it directly — no merge-base guessing needed
  if (sinceCommit) {
    try {
      const { stdout: committedDiff } = await execFileAsync(
        'git',
        ['diff', sinceCommit, 'HEAD', '--no-color'],
        bufOpts,
      );

      const { stdout: uncommittedDiff } = await execFileAsync(
        'git',
        ['diff', 'HEAD', '--no-color'],
        bufOpts,
      );

      const combined = uncommittedDiff.trim()
        ? `${committedDiff}\n${uncommittedDiff}`
        : committedDiff;

      if (combined.trim()) {
        return combined;
      }
    } catch {
      // sinceCommit may be invalid — fall through to merge-base
    }
  }

  // Try merge-base diff with multiple ref forms (bare repos may store as origin/*)
  for (const ref of [baseBranch, `origin/${baseBranch}`]) {
    try {
      const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', 'HEAD', ref], {
        cwd: worktreePath,
      });

      const { stdout: committedDiff } = await execFileAsync(
        'git',
        ['diff', mergeBase.trim(), 'HEAD', '--no-color'],
        bufOpts,
      );

      // Also grab any uncommitted changes
      const { stdout: uncommittedDiff } = await execFileAsync(
        'git',
        ['diff', 'HEAD', '--no-color'],
        bufOpts,
      );

      const combined = uncommittedDiff.trim()
        ? `${committedDiff}\n${uncommittedDiff}`
        : committedDiff;

      if (combined.trim()) {
        return combined;
      }
    } catch {
      // Try next ref form
    }
  }

  // Last resort: diff HEAD~1
  try {
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD~1...HEAD', '--no-color'], bufOpts);
    return stdout;
  } catch {
    return '';
  }
}

// MARK: - Helpers

function getBaseBranch(profileStore: ProfileStore, profileName: string): string {
  try {
    const profile = profileStore.get(profileName);
    return profile?.defaultBranch ?? 'main';
  } catch {
    return 'main';
  }
}

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileDiffs = raw.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileDiffs) {
    const lines = chunk.split('\n');
    const headerLine = lines[0] ?? '';

    // Extract file path from +++ line
    let path = '';
    let status: 'added' | 'modified' | 'deleted' = 'modified';

    for (const line of lines) {
      if (line.startsWith('+++ b/')) {
        path = line.slice(6);
      } else if (line.startsWith('+++ /dev/null')) {
        status = 'deleted';
      } else if (line.startsWith('--- /dev/null')) {
        status = 'added';
      } else if (line.startsWith('new file mode')) {
        status = 'added';
      } else if (line.startsWith('deleted file mode')) {
        status = 'deleted';
      }
    }

    // If path is empty (deleted file), try extracting from --- line
    if (!path) {
      for (const line of lines) {
        if (line.startsWith('--- a/')) {
          path = line.slice(6);
          break;
        }
      }
    }

    if (path) {
      files.push({
        path,
        status,
        diff: `diff --git ${chunk}`,
      });
    }
  }

  return files;
}

function countLines(diff: string, prefix: string): number {
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) {
      count++;
    }
  }
  return count;
}
