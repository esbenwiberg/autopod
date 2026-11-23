import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { managedGit } from '../managed/source-git.js';
import {
  exportAnchoredDelegationBundle,
  MAX_ANCHORED_INTEGRATION_BYTES,
  withVerifiedAnchoredDelegationMirror,
} from './anchored-delegation-source.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'autopod-source-anchor-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work');
  await managedGit(root, ['init', '-b', 'main', work]);
  const git = (args: string[]) => managedGit(work, args);
  const commit = (name: string) =>
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      name,
    ]);
  // Incompressible tracked content, bigger than the evaluator's entire transport limit.
  await writeFile(path.join(work, 'existing.bin'), randomBytes(3 * 1024 * 1024));
  await git(['add', '.']);
  await commit('published base');
  const predecessor = await git(['rev-parse', 'HEAD']);
  const predecessorTree = await git(['rev-parse', 'HEAD^{tree}']);
  const baseMirror = path.join(root, 'independent.git');
  await managedGit(root, ['clone', '--bare', '--no-local', '--', work, baseMirror]);
  const baseFiles = await readdir(path.join(baseMirror, 'objects', 'pack'));
  for (const [role, content] of [
    ['count', '24\n'],
    ['reason', '24 is twice 12\n'],
  ]) {
    await git(['switch', '-c', role!, predecessor]);
    await writeFile(path.join(work, role!), content!);
    await git(['add', role!]);
    await commit(role!);
  }
  await git(['switch', 'count']);
  await git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'merge',
    '--no-ff',
    '-m',
    'combined',
    'reason',
  ]);
  const selection = {
    predecessor,
    predecessorTree,
    commit: await git(['rev-parse', 'HEAD']),
    tree: await git(['rev-parse', 'HEAD^{tree}']),
  };
  return { root, work, git, baseMirror, baseFiles, selection, scratch: path.join(root, 'scratch') };
}

it('carries a small combined change even if the independently pinned base is above the transport limit', async () => {
  const f = await fixture();
  const full = path.join(f.root, 'full.bundle');
  await f.git(['bundle', 'create', full, 'HEAD']);
  const fullSize = Number(
    await f.git(['cat-file', '-s', `${f.selection.predecessor}:existing.bin`]),
  );
  expect((await stat(full)).size).toBeGreaterThan(MAX_ANCHORED_INTEGRATION_BYTES);
  const bundle = await exportAnchoredDelegationBundle(f.work, f.selection);
  expect(bundle.length).toBeLessThan(4096);
  await withVerifiedAnchoredDelegationMirror({ ...f, bundle }, async (mirror) => {
    expect(await managedGit(mirror, ['rev-parse', 'HEAD^{tree}'])).toBe(f.selection.tree);
    expect(await managedGit(mirror, ['show', 'HEAD:count'])).toBe('24');
    expect(await managedGit(mirror, ['show', 'HEAD:reason'])).toBe('24 is twice 12');
    expect(await managedGit(mirror, ['cat-file', '-s', 'HEAD:existing.bin'])).toBe(
      String(fullSize),
    );
    expect(await managedGit(mirror, ['remote'])).toBe('');
  });
  expect(await managedGit(f.baseMirror, ['rev-parse', 'HEAD'])).toBe(f.selection.predecessor);
  expect(await readdir(path.join(f.baseMirror, 'objects', 'pack'))).toEqual(f.baseFiles);
  await expect(managedGit(f.baseMirror, ['cat-file', '-e', f.selection.commit])).rejects.toThrow();
  expect(await readdir(f.scratch)).toEqual([]);
});

it('rejects a substituted base or tree, tampered pack, and oversized transfer before using the mirror', async () => {
  const f = await fixture();
  const bundle = await exportAnchoredDelegationBundle(f.work, f.selection);
  const callback = () => {
    throw new Error('must not use invalid source');
  };
  const invalid = Buffer.from(bundle);
  invalid[invalid.length - 1] = invalid[invalid.length - 1]! ^ 1;
  await expect(
    withVerifiedAnchoredDelegationMirror({ ...f, bundle: invalid }, callback),
  ).rejects.toThrow('pack-format');
  await expect(
    withVerifiedAnchoredDelegationMirror({ ...f, bundle, maxBytes: 256 }, callback),
  ).rejects.toThrow('bundle-size');
  for (const selection of [
    { ...f.selection, predecessor: 'a'.repeat(40) },
    { ...f.selection, predecessorTree: f.selection.tree },
    { ...f.selection, tree: f.selection.predecessorTree },
  ])
    await expect(
      withVerifiedAnchoredDelegationMirror({ ...f, selection, bundle }, callback),
    ).rejects.toThrow(/pack-format|tree-mismatch/);
  const bare = path.join(f.root, 'empty.git');
  await managedGit(f.root, ['init', '--bare', bare]);
  await expect(
    withVerifiedAnchoredDelegationMirror({ ...f, bundle, baseMirror: bare }, callback),
  ).rejects.toThrow('managed-git-operation-failed');
  expect(await readdir(f.scratch)).toEqual([]);
});
