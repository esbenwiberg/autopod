import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RepositoryConfig } from '@autopod/shared';
import { expect, it, onTestFinished, vi } from 'vitest';
import { managedGit } from '../managed/source-git.js';
import { publishedDelegationSource, publishedSeedReceipt } from './published-delegation-base.js';

it('retains authenticated published refs once, detects moving branches, and opens the old exact tree after restart', async () => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'published-base-'));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  const remote = path.join(root, 'source');
  await managedGit(root, ['init', '-b', 'main', remote]);
  const git = (args: string[]) => managedGit(remote, args);
  const commit = async (body: string) => {
    await writeFile(path.join(remote, 'proof.txt'), body);
    await git(['add', 'proof.txt']);
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      body,
    ]);
    return git(['rev-parse', 'HEAD']);
  };
  await commit('root');
  let observed = await commit('reviewed');
  const repo = {
    provider: 'github',
    remote: 'https://github.com/autopod-fixture/source',
  } as RepositoryConfig;
  const credentials = { username: 'fixture', token: 'fixture-token' };
  const github = { resolveCredential: vi.fn(async () => credentials), getStatus: vi.fn() };
  const mirror = path.join(root, 'retained.git');
  const fetchBranch: typeof managedGit = vi.fn(async (cwd, args, credential) => {
    expect(credential).toEqual({
      token: credentials.token,
      url: repo.remote,
      mode: 'github-basic',
    });
    expect(args.at(-2)).toBe(repo.remote);
    const local = args.map((a) => (a === repo.remote ? remote : a));
    return managedGit(cwd, local);
  });
  const input = {
    mirror,
    scratch: path.join(root, 'scratch'),
    github,
    fetchBranch,
    readBranchHead: vi.fn(async () => observed),
  };
  const source = publishedDelegationSource(input);
  const first = await source.resolve(repo, 'main', 'a'.repeat(64));
  expect(first.commit).toBe(observed);
  expect(publishedSeedReceipt(first).length).toBeLessThan(512);
  expect(await source.resolve(repo, 'main', first.repositoryDigest)).toEqual(first);
  expect(fetchBranch).toHaveBeenCalledOnce();
  const newer = await commit('next reviewed version');
  observed = '1'.repeat(40);
  await expect(source.resolve(repo, 'main', first.repositoryDigest)).rejects.toThrow(
    'branch-moved',
  );
  observed = newer;
  const second = await source.resolve(repo, 'main', first.repositoryDigest);
  expect(second.commit).not.toBe(first.commit);
  const reopened = publishedDelegationSource(input);
  await reopened.withBase(first, async (disposable) => {
    expect(await managedGit(disposable, ['rev-parse', 'HEAD^{tree}'])).toBe(first.tree);
    expect(await managedGit(disposable, ['show', 'HEAD:proof.txt'])).toBe('reviewed');
    expect(await managedGit(disposable, ['remote'])).toBe('');
  });
  await expect(reopened.withBase({ ...first, tree: second.tree }, async () => {})).rejects.toThrow(
    'custody-mismatch',
  );
  expect(github.resolveCredential).toHaveBeenCalledTimes(3);
  await expect(
    source.resolve(
      { ...repo, remote: 'https://github.com.evil.test/a/b' },
      'main',
      first.repositoryDigest,
    ),
  ).rejects.toThrow('source-invalid');
});
