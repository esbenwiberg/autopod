import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalWorktreeManager } from './local-worktree-manager.js';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'silent' });
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, env: gitEnv });
  return result.stdout.trim();
}

async function commitFile(repo: string, name: string, content: string, message: string) {
  await writeFile(path.join(repo, name), content);
  await git(repo, ['add', name]);
  await git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

type RemoteOverride = {
  getAuthenticatedRemote(worktreePath: string): Promise<{ url: string }>;
  getAuthenticatedRemoteForRepo(repoUrl: string): Promise<{ url: string }>;
};

describe('LocalWorktreeManager real Git regressions', () => {
  let root: string;
  let remote: string;
  let seed: string;
  let cacheDir: string;
  let worktreeDir: string;
  let manager: LocalWorktreeManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'autopod-worktree-git-'));
    remote = path.join(root, 'remote.git');
    seed = path.join(root, 'seed');
    cacheDir = path.join(root, 'cache');
    worktreeDir = path.join(root, 'worktrees');
    await git(root, ['init', '--bare', '--initial-branch=main', remote]);
    await git(root, ['clone', remote, seed]);
    await commitFile(seed, 'base.txt', 'base\n', 'base');
    await git(seed, ['push', 'origin', 'HEAD:refs/heads/main']);
    manager = new LocalWorktreeManager({ cacheDir, worktreeDir, logger });
    const override = manager as unknown as RemoteOverride;
    override.getAuthenticatedRemote = async () => ({ url: remote });
    override.getAuthenticatedRemoteForRepo = async () => ({ url: remote });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function createRebasedFeature(sessionId: string) {
    const result = await manager.create({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'feature',
      baseBranch: 'main',
      sessionId,
    });
    await commitFile(result.worktreePath, 'feature.txt', 'one\n', 'feature');
    await manager.pushBranch(result.worktreePath, 'feature');
    await git(result.worktreePath, [
      'fetch',
      remote,
      '+refs/heads/feature:refs/remotes/origin/feature',
    ]);
    await writeFile(path.join(result.worktreePath, 'feature.txt'), 'rebased\n');
    await git(result.worktreePath, ['commit', '-am', 'rewrite feature']);
    return result.worktreePath;
  }

  it('force-pushes to a URL when the explicit remote OID lease still matches', async () => {
    const worktree = await createRebasedFeature('lease-success');

    await manager.pushBranch(worktree, 'feature', { force: true });

    expect(await git(remote, ['rev-parse', 'refs/heads/feature'])).toBe(
      await git(worktree, ['rev-parse', 'HEAD']),
    );
  });

  it('rejects a force push when the remote branch advanced after the tracked OID', async () => {
    const worktree = await createRebasedFeature('lease-reject');
    await git(seed, ['fetch', 'origin', 'feature:feature']);
    await git(seed, ['checkout', 'feature']);
    const concurrentOid = await commitFile(seed, 'concurrent.txt', 'other\n', 'concurrent');
    await git(seed, ['push', 'origin', 'feature']);

    await expect(manager.pushBranch(worktree, 'feature', { force: true })).rejects.toThrow();
    expect(await git(remote, ['rev-parse', 'refs/heads/feature'])).toBe(concurrentOid);
  });

  it('starts from fresh origin/main while stale local main is linked elsewhere', async () => {
    await manager.create({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'linked-main',
      baseBranch: 'main',
      sessionId: 'linked-main',
    });
    const freshOid = await commitFile(seed, 'fresh.txt', 'fresh\n', 'fresh main');
    await git(seed, ['push', 'origin', 'main']);

    const result = await manager.create({
      repoUrl: 'https://github.com/org/repo.git',
      branch: 'new-pod',
      baseBranch: 'main',
      sessionId: 'new-pod',
    });

    expect(await git(result.worktreePath, ['rev-parse', 'HEAD'])).toBe(freshOid);
    expect(await git(result.worktreePath, ['rev-parse', 'refs/heads/main'])).not.toBe(freshOid);
  });
});
