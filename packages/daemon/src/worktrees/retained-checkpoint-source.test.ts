import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyRetainedCheckpointSource } from './retained-checkpoint-source.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'retained-source-'));
  roots.push(worktree);
  const git = async (...args: string[]) =>
    (
      await exec('git', args, {
        cwd: worktree,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Autopod',
          GIT_AUTHOR_EMAIL: 'autopod@localhost',
          GIT_COMMITTER_NAME: 'Autopod',
          GIT_COMMITTER_EMAIL: 'autopod@localhost',
        },
      })
    ).stdout.trim();
  await git('init', '-b', 'feature');
  await writeFile(path.join(worktree, 'source.txt'), 'selected');
  await git('add', '.');
  await git('commit', '-m', 'selected source');
  const head = await git('rev-parse', 'HEAD');
  const tree = await git('rev-parse', 'HEAD^{tree}');
  const inspect = async () => ({
    branch: 'feature',
    commitSha: await git('rev-parse', 'HEAD'),
    treeSha: await git('--no-replace-objects', 'rev-parse', 'HEAD^{tree}'),
    worktreeClean: !(await git('status', '--porcelain')),
  });
  const input = { worktree, podId: 'pod', branch: 'feature', head, tree, inspect };
  const checkpoint = async (parent: string, snapshotTree = tree, namespace = 'pod') => {
    const sha = await git(
      'commit-tree',
      snapshotTree,
      '-p',
      parent,
      '-m',
      'autopod sandbox checkpoint',
    );
    await git('update-ref', `refs/autopod-quarantine/${namespace}/${sha}`, sha);
    await git('reset', '--hard', sha);
    return sha;
  };
  return { input, git, checkpoint };
}
describe('retained checkpoint source proof', () => {
  it('accepts exact source and a chain of pod-quarantined same-tree transport checkpoints', async () => {
    const f = await fixture();
    expect((await verifyRetainedCheckpointSource(f.input))?.checkpoints).toEqual([]);
    const first = await f.checkpoint(f.input.head);
    const second = await f.checkpoint(first);
    expect(await verifyRetainedCheckpointSource(f.input)).toEqual({
      head: second,
      selectedHead: f.input.head,
      tree: f.input.tree,
      checkpoints: [second, first],
    });
  });
  it.each(['missing', 'other-pod'])(
    'rejects a %s quarantine proof despite matching actor, subject and tree',
    async (kind) => {
      const f = await fixture();
      const sha = await f.checkpoint(f.input.head, f.input.tree, 'other');
      if (kind === 'missing')
        await f.git('update-ref', '-d', `refs/autopod-quarantine/other/${sha}`);
      expect(await verifyRetainedCheckpointSource(f.input)).toBeNull();
    },
  );
  it('rejects changed-and-reverted checkpoint trees', async () => {
    const f = await fixture();
    await writeFile(path.join(f.input.worktree, 'source.txt'), 'changed');
    await f.git('add', '.');
    const changedTree = await f.git('write-tree');
    const changed = await f.checkpoint(f.input.head, changedTree);
    await f.checkpoint(changed);
    expect(await verifyRetainedCheckpointSource(f.input)).toBeNull();
  });
  it('rejects untracked edits and arbitrary same-tree commits', async () => {
    const f = await fixture();
    await writeFile(path.join(f.input.worktree, 'unexpected.ts'), 'source');
    expect(await verifyRetainedCheckpointSource(f.input)).toBeNull();
    await rm(path.join(f.input.worktree, 'unexpected.ts'));
    await f.git('commit', '--allow-empty', '-m', 'not a transport checkpoint');
    expect(await verifyRetainedCheckpointSource(f.input)).toBeNull();
  });
  it('rejects replace refs during transport interpretation', async () => {
    const f = await fixture();
    const tip = await f.checkpoint(f.input.head);
    await f.git('replace', tip, f.input.head);
    expect(await verifyRetainedCheckpointSource(f.input)).toBeNull();
  });
});
