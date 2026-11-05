import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectCheckpointSource } from './checkpoint-source-identity.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'checkpoint-source-identity-'));
  roots.push(root);
  const git = async (...args: string[]) =>
    (
      await exec('git', args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      })
    ).stdout.trim();
  await git('init', '-b', 'feature');
  await writeFile(path.join(root, 'source.ts'), 'original\n');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'source',
  );
  const head = await git('rev-parse', 'HEAD');
  const tree = await git('rev-parse', 'HEAD^{tree}');
  let sequence = 0;
  const checkpoint = async (podId = 'pod', subject = 'autopod sandbox checkpoint') => {
    await git(
      '-c',
      'user.name=Autopod',
      '-c',
      'user.email=autopod@localhost',
      'commit',
      '--allow-empty',
      '-am',
      subject,
    );
    const commit = await git('rev-parse', 'HEAD');
    await git('update-ref', `refs/autopod-quarantine/${podId}/${++sequence}`, commit);
    return commit;
  };
  const input = {
    podId: 'pod',
    worktreePath: root,
    branch: 'feature',
    head,
    tree,
    worktreeManager: {
      inspectSourceAdoption: async () => ({
        branch: await git('branch', '--show-current'),
        commitSha: await git('rev-parse', 'HEAD'),
        treeSha: await git('rev-parse', 'HEAD^{tree}'),
        worktreeClean: (await git('status', '--porcelain')).length === 0,
      }),
    },
    assertCurrent() {},
  };
  return { root, git, head, tree, checkpoint, input };
}

describe('selected checkpoint source identity', () => {
  it('accepts the exact clean anchor without creating refs or changing source', async () => {
    const f = await fixture();
    const refs = await f.git('show-ref');
    expect(await inspectCheckpointSource(f.input)).toEqual({
      head: f.head,
      tree: f.tree,
      checkpoints: [],
    });
    expect(await f.git('show-ref')).toBe(refs);
    expect(await f.git('status', '--porcelain')).toBe('');
  });
  it('accepts two exact owned no-op captures, without resetting the selected branch', async () => {
    const f = await fixture();
    const first = await f.checkpoint();
    const second = await f.checkpoint();
    const refs = await f.git('show-ref');
    expect(await inspectCheckpointSource(f.input)).toEqual({
      head: second,
      tree: f.tree,
      checkpoints: [second, first],
    });
    expect(await f.git('rev-parse', 'HEAD')).toBe(second);
    expect(await f.git('show-ref')).toBe(refs);
  });
  it.each([
    'other-pod',
    'unowned',
    'agent-commit',
  ])('rejects an equal-tree %s commit', async (kind) => {
    const f = await fixture();
    const commit = await f.checkpoint(
      kind === 'other-pod' ? 'other-pod' : 'pod',
      kind === 'agent-commit' ? 'agent no-op' : undefined,
    );
    if (kind === 'unowned') await f.git('update-ref', '-d', 'refs/autopod-quarantine/pod/1');
    await expect(inspectCheckpointSource(f.input)).rejects.toMatchObject({
      code: 'CHECKPOINT_SOURCE_CHANGED',
    });
    expect(await f.git('rev-parse', 'HEAD')).toBe(commit);
  });
  it('rejects a content change even when a later owned checkpoint restores the original tree', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'source.ts'), 'changed\n');
    await f.checkpoint();
    await writeFile(path.join(f.root, 'source.ts'), 'original\n');
    await f.checkpoint();
    await expect(inspectCheckpointSource(f.input)).rejects.toMatchObject({
      code: 'CHECKPOINT_SOURCE_CHANGED',
    });
  });
  it('refuses an owned equal-tree merge commit instead of guessing its source lineage', async () => {
    const f = await fixture();
    const parent = await f.checkpoint();
    const merge = await f.git(
      '-c',
      'user.name=Autopod',
      '-c',
      'user.email=autopod@localhost',
      'commit-tree',
      f.tree,
      '-p',
      parent,
      '-p',
      f.head,
      '-m',
      'autopod sandbox checkpoint',
    );
    await f.git('update-ref', 'refs/autopod-quarantine/pod/merge', merge);
    await f.git('reset', '--hard', merge);
    // Even a local graft claiming only one parent cannot replace raw Git evidence.
    await writeFile(path.join(f.root, '.git/info/grafts'), `${merge} ${parent}\n`);
    await expect(inspectCheckpointSource(f.input)).rejects.toMatchObject({
      code: 'CHECKPOINT_SOURCE_CHANGED',
    });
  });
  it('rejects dirty or wrong-branch source even with the exact selected tree', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'untracked.ts'), 'untracked\n');
    await expect(inspectCheckpointSource(f.input)).rejects.toMatchObject({
      code: 'CHECKPOINT_SOURCE_CHANGED',
    });
    await rm(path.join(f.root, 'untracked.ts'));
    await f.git('switch', '-c', 'different');
    await expect(inspectCheckpointSource(f.input)).rejects.toMatchObject({
      code: 'CHECKPOINT_SOURCE_CHANGED',
    });
  });
  it('rejects a source inspection whose generation was superseded', async () => {
    const f = await fixture();
    await f.checkpoint();
    let reads = 0;
    await expect(
      inspectCheckpointSource({
        ...f.input,
        assertCurrent() {
          if (++reads > 4) throw new Error('superseded');
        },
      }),
    ).rejects.toThrow('superseded');
  });
});
