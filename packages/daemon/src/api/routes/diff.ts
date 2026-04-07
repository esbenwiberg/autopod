import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { ProfileStore } from '../../profiles/index.js';
import type { ContainerManagerFactory, SessionManager } from '../../sessions/session-manager.js';

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
  sessionManager: SessionManager,
  containerManagerFactory: ContainerManagerFactory,
  profileStore: ProfileStore,
): void {
  // GET /sessions/:sessionId/diff — get unified diff for a session
  app.get('/sessions/:sessionId/diff', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = sessionManager.getSession(sessionId);

    const baseBranch = getBaseBranch(profileStore, session.profileName);

    // Strategy 1: Try container-based diff (works when container is running)
    let rawDiff = '';
    if (session.containerId) {
      rawDiff = await tryContainerDiff(
        containerManagerFactory,
        session.containerId,
        session.executionTarget,
        baseBranch,
      );
    }

    // Strategy 2: Fall back to host-side worktree diff (works after container stops)
    if (!rawDiff.trim() && session.worktreePath) {
      rawDiff = await tryWorktreeDiff(session.worktreePath, baseBranch);
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
): Promise<string> {
  const cm = containerManagerFactory.get(executionTarget);
  const workDir = '/workspace';

  try {
    await cm.execInContainer(containerId, ['git', 'fetch', 'origin', '--quiet'], {
      cwd: workDir,
      timeout: 15_000,
    });

    const result = await cm.execInContainer(
      containerId,
      ['git', 'diff', `origin/${baseBranch}...HEAD`, '--no-color'],
      { cwd: workDir, timeout: 30_000 },
    );

    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout;
    }
  } catch {
    // Container may be stopped — fall through
  }

  // Fallback: uncommitted or last-commit diff
  try {
    const result = await cm.execInContainer(containerId, ['git', 'diff', 'HEAD', '--no-color'], {
      cwd: workDir,
      timeout: 30_000,
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout;
    }

    const committed = await cm.execInContainer(
      containerId,
      ['git', 'diff', 'HEAD~1...HEAD', '--no-color'],
      { cwd: workDir, timeout: 30_000 },
    );
    if (committed.exitCode === 0) {
      return committed.stdout;
    }
  } catch {
    // Container unavailable
  }

  return '';
}

async function tryWorktreeDiff(worktreePath: string, baseBranch: string): Promise<string> {
  try {
    // Verify the worktree still exists on disk
    await access(worktreePath);
  } catch {
    return '';
  }

  const bufOpts = { cwd: worktreePath, maxBuffer: 2 * 1024 * 1024 };

  // Try merge-base diff first (committed changes since branching)
  try {
    const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', 'HEAD', baseBranch], {
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
    // merge-base may fail if baseBranch ref doesn't exist locally
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
