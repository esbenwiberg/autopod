import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalWorktreeManager } from './local-worktree-manager.js';
import { prepareRetainedCheckpointWorkspace } from './retained-checkpoint-workspace.js';

const exec = promisify(execFile);
const roots: string[] = [];
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const repository = 'https://github.com/fixture/retained';
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, env })).stdout.trim();
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'retained-divergent-'));
  roots.push(root);
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const original = path.join(root, 'original');
  await git(root, 'init', '--bare', '--initial-branch=main', remote);
  await git(root, 'clone', remote, seed);
  await writeFile(path.join(seed, 'base.txt'), 'base\n');
  await writeFile(path.join(seed, '.gitignore'), 'report.bin\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'base');
  await git(seed, 'push', 'origin', 'main');
  await git(seed, 'checkout', '-b', 'feature');
  await writeFile(path.join(seed, 'task.txt'), 'task change\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'task');
  await git(seed, 'push', 'origin', 'feature');
  await git(root, 'clone', '--branch', 'feature', remote, original);
  await git(seed, 'checkout', 'main');
  await writeFile(path.join(seed, 'main.txt'), 'main advanced\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'advance main');
  await git(seed, 'push', 'origin', 'main');
  const base = await git(seed, 'rev-parse', 'HEAD');
  await git(seed, 'checkout', 'feature');
  await git(seed, 'merge', '--no-edit', 'main');
  await git(seed, 'push', 'origin', 'feature');
  const remoteHead = await git(seed, 'rev-parse', 'HEAD');
  await git(original, 'fetch', 'origin', 'main');
  await git(original, 'rebase', 'origin/main');
  const head = await git(original, 'rev-parse', 'HEAD');
  expect(head).not.toBe(remoteHead);
  await writeFile(path.join(original, 'report.bin'), Buffer.from([0, 255, 1, 2]));
  const archiveParent = path.join(root, 'recoveries');
  await mkdir(archiveParent);
  const prepared = await prepareRetainedCheckpointWorkspace({
    source: original,
    root: path.join(archiveParent, 'selection'),
    branch: 'feature',
    repository,
    head,
    generation: 1,
    cycle: 0,
    assertCurrent() {},
  });
  // Only the transport is substituted. The maintained command runner executes real Git,
  // with repository identity still HTTPS; no live provider authorization is claimed.
  await git(prepared.bare, 'config', `url.file://${remote}.insteadOf`, repository);
  const manager = new LocalWorktreeManager({
    cacheDir: path.join(root, 'cache'),
    worktreeDir: path.join(root, 'unused'),
    logger: pino({ level: 'silent' }),
  });
  (
    manager as unknown as { getAuthenticatedRemote(): Promise<{ url: string }> }
  ).getAuthenticatedRemote = async () => ({ url: repository });
  const input = {
    worktreePath: prepared.worktree,
    originalWorktreePath: original,
    repository,
    branch: 'feature',
    head,
    remoteHead,
    baseBranch: 'main',
    assertCurrent() {},
  };
  return { root, original, remote, prepared, manager, input, head, base, remoteHead };
}

describe('retained continuation real Git isolation', () => {
  it('selects a divergent published head and fresh base without resetting or sharing original history', async () => {
    const f = await fixture();
    const selected = await f.manager.selectRetainedContinuationSource(f.input);
    expect(selected.head).toBe(f.remoteHead);
    expect(selected.baseCommitSha).toBe(f.base);
    expect(await git(f.original, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(await readFile(path.join(f.original, 'report.bin'))).toEqual(
      Buffer.from([0, 255, 1, 2]),
    );
    expect(await readFile(path.join(f.prepared.snapshot, 'report.bin'))).toEqual(
      Buffer.from([0, 255, 1, 2]),
    );
    expect(await git(f.remote, 'rev-parse', 'refs/heads/feature')).toBe(f.remoteHead);
    expect(await git(f.prepared.worktree, 'status', '--porcelain')).toBe('');
    expect(await git(f.original, 'rev-parse', '--git-common-dir')).not.toBe(
      await git(f.prepared.worktree, 'rev-parse', '--git-common-dir'),
    );
  });
  it('refuses remote movement without rewinding either the original or remote branch', async () => {
    const f = await fixture();
    await expect(
      f.manager.selectRetainedContinuationSource({ ...f.input, remoteHead: 'f'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'SOURCE_REMOTE_CHANGED' });
    expect(await git(f.original, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(await git(f.prepared.worktree, 'rev-parse', 'HEAD')).toBe(f.head);
    expect(await git(f.remote, 'rev-parse', 'refs/heads/feature')).toBe(f.remoteHead);
  });
  it('refuses selecting into the original namespace before fetching or checkout', async () => {
    const f = await fixture();
    await expect(
      f.manager.selectRetainedContinuationSource({ ...f.input, worktreePath: f.original }),
    ).rejects.toThrow('independent');
    expect(await git(f.original, 'rev-parse', 'HEAD')).toBe(f.head);
  });
  it('can retain the exact host source while refreshing only the private base ref', async () => {
    const f = await fixture();
    const selected = await f.manager.selectRetainedContinuationSource({
      ...f.input,
      remoteHead: undefined,
    });
    expect(selected.head).toBe(f.head);
    expect(selected.baseCommitSha).toBe(f.base);
    expect(await git(f.original, 'rev-parse', 'HEAD')).toBe(f.head);
  });
});
