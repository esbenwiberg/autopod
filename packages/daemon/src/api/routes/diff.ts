import type { FastifyInstance } from 'fastify';
import type { ContainerManagerFactory, SessionManager } from '../../sessions/session-manager.js';

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
): void {
  // GET /sessions/:sessionId/diff — get unified diff for a session
  app.get('/sessions/:sessionId/diff', async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = sessionManager.getSession(sessionId);

    if (!session.containerId) {
      return { files: [], stats: { added: 0, removed: 0, changed: 0 } } satisfies DiffResponse;
    }

    const cm = containerManagerFactory.get(session.executionTarget);
    const workDir = '/workspace';

    // Get the diff against the base branch (or HEAD~1 if no base)
    const diffBase = session.baseBranch ?? session.branch.replace(/^feat\/|^fix\/|^refactor\//, '');

    // First try diff against origin/main (or the default branch)
    let rawDiff = '';
    try {
      // Fetch latest refs so we have something to diff against
      const fetchResult = await cm.execInContainer(
        session.containerId,
        ['git', 'fetch', 'origin', '--quiet'],
        { cwd: workDir, timeout: 15_000 },
      );

      // Try diffing against origin/<defaultBranch>
      const profile = await getProfileForSession(sessionManager, session);
      const baseBranch = profile?.defaultBranch ?? 'main';

      const result = await cm.execInContainer(
        session.containerId,
        ['git', 'diff', `origin/${baseBranch}...HEAD`, '--no-color'],
        { cwd: workDir, timeout: 30_000 },
      );

      if (result.exitCode === 0) {
        rawDiff = result.stdout;
      }
    } catch {
      // Fallback: diff against HEAD~1 or show all uncommitted changes
      try {
        const result = await cm.execInContainer(
          session.containerId,
          ['git', 'diff', 'HEAD', '--no-color'],
          { cwd: workDir, timeout: 30_000 },
        );
        if (result.exitCode === 0 && result.stdout.trim()) {
          rawDiff = result.stdout;
        } else {
          // Try committed changes
          const logResult = await cm.execInContainer(
            session.containerId,
            ['git', 'log', '--oneline', '-1'],
            { cwd: workDir, timeout: 5_000 },
          );
          if (logResult.exitCode === 0) {
            const committed = await cm.execInContainer(
              session.containerId,
              ['git', 'diff', 'HEAD~1...HEAD', '--no-color'],
              { cwd: workDir, timeout: 30_000 },
            );
            if (committed.exitCode === 0) {
              rawDiff = committed.stdout;
            }
          }
        }
      } catch {
        // Give up — no diff available
      }
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

// MARK: - Helpers

function getProfileForSession(sessionManager: SessionManager, session: { profileName: string }) {
  try {
    // SessionManager may have a profile store reference
    // For now, return null and use 'main' as default
    return null;
  } catch {
    return null;
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
