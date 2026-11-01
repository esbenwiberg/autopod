import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { checkpointError } from '../pods/retained-checkpoint-repository.js';
import { safeAdoptionGit } from './source-adoption-git.js';

const exec = promisify(execFile);

/** Tree equality alone is insufficient: every extra commit must be an exact,
 * single-parent, no-op checkpoint retained in THIS pod's quarantine namespace.
 * No ref, index, worktree, original sandbox or report is modified here.
 */
export async function inspectCheckpointSource(input: {
  podId: string;
  worktreePath: string;
  branch: string;
  head: string;
  tree: string;
  worktreeManager: Pick<WorktreeManager, 'inspectSourceAdoption'>;
  assertCurrent(): void;
}): Promise<{ head: string; tree: string; checkpoints: string[] }> {
  const { worktreeManager, assertCurrent } = input;
  const inspect = async () => {
    assertCurrent();
    const source = await worktreeManager.inspectSourceAdoption?.(input.worktreePath, input.branch);
    assertCurrent();
    if (!source?.worktreeClean || source.branch !== input.branch || source.treeSha !== input.tree)
      checkpointError('Selected checkpoint source changed', 'CHECKPOINT_SOURCE_CHANGED');
    return source;
  };
  const source = await inspect();
  const checkpoints: string[] = [];
  if (source.commitSha !== input.head) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    );
    const git = safeAdoptionGit(async (args) => {
      assertCurrent();
      const result = await exec('git', args, {
        cwd: input.worktreePath,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      assertCurrent();
      return result;
    });
    const namespace = `refs/autopod-quarantine/${input.podId.replace(/[^A-Za-z0-9_-]/g, '_')}/`;
    let head = source.commitSha;
    for (let depth = 0; head !== input.head && depth < 64; depth++) {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))
        checkpointError('Checkpoint commit identity unavailable', 'CHECKPOINT_SOURCE_CHANGED');
      const refs = (
        await git(['for-each-ref', '--format=%(refname)', '--points-at', head, namespace])
      ).stdout.trim();
      // Read raw commit headers, not revision-walker parents: grafts must not
      // turn a merge or unrelated commit into an apparent single-parent capture.
      const raw = (await git(['cat-file', 'commit', head])).stdout;
      const separator = raw.indexOf('\n\n');
      const headers = raw.slice(0, separator).split('\n');
      const parents = headers.filter((line) => line.startsWith('parent '));
      const parent = parents[0]?.slice(7);
      if (
        !refs ||
        separator < 0 ||
        parents.length !== 1 ||
        raw.slice(separator + 2).split('\n')[0] !== 'autopod sandbox checkpoint' ||
        !headers.some((line) =>
          /^author Autopod <autopod@localhost> [0-9]+ [+-][0-9]{4}$/.test(line),
        ) ||
        !headers.some((line) =>
          /^committer Autopod <autopod@localhost> [0-9]+ [+-][0-9]{4}$/.test(line),
        ) ||
        !headers.includes(`tree ${input.tree}`) ||
        !parent ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parent)
      )
        checkpointError(
          'Source is not an owned no-op checkpoint lineage',
          'CHECKPOINT_SOURCE_CHANGED',
        );
      checkpoints.push(head);
      head = parent;
    }
    if (head !== input.head)
      checkpointError(
        'Selected checkpoint is not the exact lineage anchor',
        'CHECKPOINT_SOURCE_CHANGED',
      );
    const after = await inspect();
    if (after.commitSha !== source.commitSha)
      checkpointError('Source changed during checkpoint inspection', 'CHECKPOINT_SOURCE_CHANGED');
    // Resolve the root as well; Git replace objects are disabled for every read.
    if ((await git(['rev-parse', `${input.head}^{tree}`])).stdout.trim() !== input.tree)
      checkpointError('Selected checkpoint tree changed', 'CHECKPOINT_SOURCE_CHANGED');
  }
  // Keep an explicit exact source identity for the reconciliation audit receipt.
  return { head: source.commitSha, tree: source.treeSha, checkpoints };
}
