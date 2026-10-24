import { type DiffResponse, parseDiff, statsForFiles } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { WorktreeManager } from '../../interfaces/worktree-manager.js';
import {
  computePodCommitDiffs,
  computePodDiff,
  computePodUncommittedDiff,
  computePodUntrackedPreview,
} from '../../pods/pod-diff-fetcher.js';
import type { ContainerManagerFactory, PodManager } from '../../pods/pod-manager.js';
import { podSourceContext } from '../../pods/pod-source-context.js';
import type { ProfileStore } from '../../profiles/index.js';

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

    const source = podSourceContext(pod, podManager.getLaunchConfiguration, (name) =>
      profileStore.get(name),
    );
    const baseBranch = pod.baseBranch ?? source.defaultBranch ?? 'main';
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

    if (!canonical.diff.trim() && source.repoUrl && worktreeManager?.getBranchDiff) {
      const branchDiff = await worktreeManager.getBranchDiff({
        repoUrl: source.repoUrl,
        branch: pod.branch,
        baseBranch,
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
