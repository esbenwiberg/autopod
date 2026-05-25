import type { FastifyInstance } from 'fastify';
import type { WorktreeManager } from '../../interfaces/worktree-manager.js';
import {
  computePodCommitDiffs,
  computePodDiff,
  computePodUncommittedDiff,
  computePodUntrackedPreview,
} from '../../pods/pod-diff-fetcher.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';
import { type ProfileStore, selectGitPat } from '../../profiles/index.js';

interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  diff: string;
  binary?: boolean;
  truncated?: boolean;
  note?: string;
}

interface DiffCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorDate: string;
  files: DiffFile[];
  stats: DiffStats;
}

interface DiffStats {
  added: number;
  removed: number;
  changed: number;
}

interface DiffResponse {
  files: DiffFile[];
  stats: DiffStats;
  previewFiles: DiffFile[];
  previewStats: DiffStats;
  uncommittedFiles: DiffFile[];
  uncommittedStats: DiffStats;
  commits: DiffCommit[];
  commitGroupingUnavailableReason?: string;
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

    const profile = getProfile(profileStore, pod.profileName);
    const baseBranch = pod.baseBranch ?? profile?.defaultBranch ?? 'main';
    const containerManager = pod.containerId
      ? containerManagerFactory.get(pod.executionTarget)
      : undefined;

    const podSlice = {
      containerId: pod.containerId ?? null,
      worktreePath: pod.worktreePath ?? null,
      startCommitSha: pod.startCommitSha ?? null,
    };

    // Single source of truth: same fetcher used by pre-submit review.
    // Single-ref `git diff <base>` folds committed + uncommitted into one net
    // delta — avoids the double-counting bug where a file committed AND modified
    // in the worktree showed up as two separate `diff --git` blocks.
    const [canonicalResult, preview, uncommitted, commitGroups] = await Promise.all([
      computePodDiff({
        pod: podSlice,
        defaultBranch: baseBranch,
        containerManager,
        worktreeManager,
        logger: request.log,
      }),
      computePodUntrackedPreview({
        pod: podSlice,
        defaultBranch: baseBranch,
        containerManager,
        worktreeManager,
        logger: request.log,
      }),
      computePodUncommittedDiff({
        pod: podSlice,
        defaultBranch: baseBranch,
        containerManager,
        worktreeManager,
        logger: request.log,
      }),
      computePodCommitDiffs({
        pod: podSlice,
        defaultBranch: baseBranch,
        containerManager,
        worktreeManager,
        logger: request.log,
      }),
    ]);
    let canonical = canonicalResult;

    if (!canonical.diff.trim() && profile?.repoUrl && worktreeManager?.getBranchDiff) {
      const branchDiff = await worktreeManager.getBranchDiff({
        repoUrl: profile.repoUrl,
        branch: pod.branch,
        baseBranch,
        pat: selectGitPat(profile),
        startCommitSha: pod.startCommitSha,
      });
      if (branchDiff.trim()) {
        canonical = { diff: branchDiff, source: 'worktree' };
      }
    }

    const files = parseDiff(canonical.diff);
    const previewFiles = preview.files;
    const uncommittedFiles = parseDiff(uncommitted.diff);
    const commits = commitGroups.commits.map((commit) => {
      const commitFiles = parseDiff(commit.diff);
      return {
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        body: commit.body,
        authorDate: commit.authorDate,
        files: commitFiles,
        stats: statsForFiles(commitFiles),
      };
    });

    return {
      files,
      stats: statsForFiles(files),
      previewFiles,
      previewStats: statsForFiles(previewFiles),
      uncommittedFiles,
      uncommittedStats: statsForFiles(uncommittedFiles),
      commits,
      ...(commitGroups.unavailableReason
        ? { commitGroupingUnavailableReason: commitGroups.unavailableReason }
        : {}),
    } satisfies DiffResponse;
  });
}

// MARK: - Helpers

function getProfile(profileStore: ProfileStore, profileName: string) {
  try {
    return profileStore.get(profileName);
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

function statsForFiles(files: DiffFile[]): DiffStats {
  return {
    added: files.reduce((sum, f) => sum + countLines(f.diff, '+'), 0),
    removed: files.reduce((sum, f) => sum + countLines(f.diff, '-'), 0),
    changed: files.length,
  };
}
