import type { FastifyInstance } from 'fastify';
import type { WorktreeManager } from '../../interfaces/worktree-manager.js';
import { computePodDiff } from '../../pods/pod-diff-fetcher.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';
import type { ProfileStore } from '../../profiles/index.js';

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
  worktreeManager?: WorktreeManager,
): void {
  // GET /pods/:podId/diff — get unified diff for a pod
  app.get('/pods/:podId/diff', async (request) => {
    const { podId } = request.params as { podId: string };
    const pod = podManager.getSession(podId);

    const baseBranch = pod.baseBranch ?? getBaseBranch(profileStore, pod.profileName);
    const containerManager = pod.containerId
      ? containerManagerFactory.get(pod.executionTarget)
      : undefined;

    // Single source of truth: same fetcher used by pre-submit review.
    // Single-ref `git diff <base>` folds committed + uncommitted into one net
    // delta — avoids the double-counting bug where a file committed AND modified
    // in the worktree showed up as two separate `diff --git` blocks.
    const { diff: rawDiff } = await computePodDiff({
      pod: {
        containerId: pod.containerId ?? null,
        worktreePath: pod.worktreePath ?? null,
        startCommitSha: pod.startCommitSha ?? null,
      },
      defaultBranch: baseBranch,
      containerManager,
      worktreeManager,
      logger: request.log,
    });

    if (!rawDiff.trim()) {
      return { files: [], stats: { added: 0, removed: 0, changed: 0 } } satisfies DiffResponse;
    }

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

    if (!path) {
      for (const line of lines) {
        if (line.startsWith('--- a/')) {
          path = line.slice(6);
          break;
        }
      }
    }

    // Mode-only changes (e.g. chmod) have no +++ or --- lines — extract path from the
    // "a/<path> b/<path>" header that follows "diff --git "
    if (!path) {
      const modeOnlyMatch = headerLine.match(/^a\/(.+) b\/.+$/);
      if (modeOnlyMatch?.[1]) {
        path = modeOnlyMatch[1];
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
