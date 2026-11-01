import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import { resolveSandboxCheckpointSourceHead } from './sandbox-workspace-checkpoint.js';

/** Accept only the selected source or same-tree, pod-quarantined transport descendants.
 * Tree equality alone, commit subjects, or arbitrary ancestor relationships are not proof.
 */
export async function verifyRetainedCheckpointSource(input: {
  worktree: string;
  podId: string;
  branch: string;
  head: string;
  tree: string;
  inspect: NonNullable<WorktreeManager['inspectSourceAdoption']>;
}) {
  const inspect = () => input.inspect(input.worktree, input.branch);
  const before = await inspect();
  if (!before.worktreeClean || before.treeSha !== input.tree) return null;
  const git = promisify(execFile);
  if (
    before.commitSha !== input.head &&
    (
      await git('git', ['for-each-ref', '--format=%(refname)', 'refs/replace'], {
        cwd: input.worktree,
      })
    ).stdout.trim()
  )
    return null;
  const checkpoints: string[] = [];
  let current = before.commitSha;
  for (let depth = 0; current !== input.head && depth < 64; depth++) {
    // This existing resolver requires the exact commit under this pod's HOST
    // quarantine refs, a single parent and the maintained checkpoint actor.
    const parent = await resolveSandboxCheckpointSourceHead(input.worktree, input.podId, current);
    if (!parent || checkpoints.includes(parent)) return null;
    // Inspection alone only describes HEAD. Verify every intermediate tree too,
    // so a changed-and-reverted checkpoint chain cannot stand in for selection.
    const result = await git('git', ['--no-replace-objects', 'rev-parse', `${parent}^{tree}`], {
      cwd: input.worktree,
    });
    if (result.stdout.trim() !== input.tree) return null;
    checkpoints.push(current);
    current = parent;
  }
  if (current !== input.head) return null;
  const after = await inspect();
  if (!after.worktreeClean || after.commitSha !== before.commitSha || after.treeSha !== input.tree)
    return null;
  return { head: before.commitSha, selectedHead: input.head, tree: input.tree, checkpoints };
}
