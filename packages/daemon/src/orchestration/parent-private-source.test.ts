import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sha256 } from '../managed/canonical.js';
import { managedGit } from '../managed/source-git.js';
import { verifyParentPrivateSource } from './parent-private-source.js';

const roots: string[] = [];
const identity = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@autopod.invalid',
  '-c',
  'commit.gpgSign=false',
];

async function fixture(
  changedPath = 'src/allowed.ts',
  content: string | Buffer = 'export const value = 1;\n',
) {
  const root = await mkdtemp(path.join(tmpdir(), 'parent-private-source-'));
  roots.push(root);
  const repository = path.join(root, 'isolated');
  await managedGit(root, ['init', '-b', 'main', repository]);
  await mkdir(path.join(repository, 'src'));
  await writeFile(path.join(repository, 'README.md'), 'base\n');
  await managedGit(repository, ['add', '--all', '--', '.']);
  await managedGit(repository, [...identity, 'commit', '-m', 'base']);
  const base = await managedGit(repository, ['rev-parse', 'HEAD']);

  await writeFile(path.join(repository, changedPath), content);
  await managedGit(repository, ['add', '--', changedPath]);
  await managedGit(repository, [...identity, 'commit', '-m', 'candidate']);
  const commit = await managedGit(repository, ['rev-parse', 'HEAD']);
  const tree = await managedGit(repository, ['rev-parse', 'HEAD^{tree}']);
  const bundlePath = path.join(root, 'export.bundle');
  await managedGit(repository, ['-c', 'pack.window=0', 'bundle', 'create', bundlePath, 'HEAD']);
  const bundle = await readFile(bundlePath);
  return { root, repository, base, commit, tree, bundle };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('binds an isolated HEAD export before awaits and returns only verified scoped source', async () => {
  const f = await fixture();
  // Dirty bytes created after the commit are deliberately absent from an exported HEAD bundle.
  await writeFile(path.join(f.repository, 'src', 'dirty.ts'), 'not committed\n');
  await writeFile(path.join(f.repository, 'src', 'allowed.ts'), 'dirty replacement\n');

  const expectedBytes = Buffer.from(f.bundle);
  const grant = { kind: 'file' as const, path: 'src/allowed.ts' };
  const selector = {
    base: f.base,
    commit: f.commit,
    tree: f.tree,
    allowlist: [grant],
    maxBundleBytes: f.bundle.length,
  };
  const pending = verifyParentPrivateSource(f.root, f.bundle, selector);

  // These mutations occur after invocation but before its first filesystem await settles.
  f.bundle.fill(0);
  selector.base = '0'.repeat(40);
  selector.commit = '1'.repeat(40);
  selector.tree = '2'.repeat(40);
  grant.path = 'src/dirty.ts';

  const source = await pending;
  expect(source).toEqual({
    base: f.base,
    commit: f.commit,
    tree: f.tree,
    bundle: expectedBytes,
    bundleDigest: sha256(expectedBytes),
    paths: ['src/allowed.ts'],
  });
  expect(source.bundle).not.toBe(f.bundle);
});

it('rejects hostile bundles that do not match the exact HEAD, tree, or host path scope', async () => {
  const wrongHead = await fixture();
  await writeFile(path.join(wrongHead.repository, 'src', 'later.ts'), 'later\n');
  await managedGit(wrongHead.repository, ['add', '--', 'src/later.ts']);
  await managedGit(wrongHead.repository, [...identity, 'commit', '-m', 'later']);
  const laterBundlePath = path.join(wrongHead.root, 'later.bundle');
  await managedGit(wrongHead.repository, ['bundle', 'create', laterBundlePath, 'HEAD']);
  const laterBundle = await readFile(laterBundlePath);
  await expect(
    verifyParentPrivateSource(wrongHead.root, laterBundle, {
      base: wrongHead.base,
      commit: wrongHead.commit,
      tree: wrongHead.tree,
      allowlist: [{ kind: 'file', path: 'src/allowed.ts' }],
      maxBundleBytes: laterBundle.length,
    }),
  ).rejects.toThrow('parent-private-source-pack-format');

  const wrongTree = await fixture();
  const baseTree = await managedGit(wrongTree.repository, [
    'rev-parse',
    `${wrongTree.base}^{tree}`,
  ]);
  await expect(
    verifyParentPrivateSource(wrongTree.root, wrongTree.bundle, {
      base: wrongTree.base,
      commit: wrongTree.commit,
      tree: baseTree,
      allowlist: [{ kind: 'file', path: 'src/allowed.ts' }],
      maxBundleBytes: wrongTree.bundle.length,
    }),
  ).rejects.toThrow('checkpoint-source-mismatch');

  const outsideScope = await fixture('src/private.ts');
  await expect(
    verifyParentPrivateSource(outsideScope.root, outsideScope.bundle, {
      base: outsideScope.base,
      commit: outsideScope.commit,
      tree: outsideScope.tree,
      allowlist: [{ kind: 'file', path: 'src/allowed.ts' }],
      maxBundleBytes: outsideScope.bundle.length,
    }),
  ).rejects.toThrow('candidate-path-scope-path-not-allowed');
});

it('rejects additional refs and objects hidden behind a single advertised HEAD', async () => {
  const f = await fixture();
  await managedGit(f.repository, ['checkout', '-b', 'other', f.base]);
  await writeFile(path.join(f.repository, 'other.txt'), 'unrelated fixture\n');
  await managedGit(f.repository, ['add', '--', 'other.txt']);
  await managedGit(f.repository, [...identity, 'commit', '-m', 'Unrelated']);
  await managedGit(f.repository, ['checkout', '--detach', f.commit]);
  const file = path.join(f.root, 'mixed.bundle');
  await managedGit(f.repository, [
    '-c',
    'pack.window=0',
    'bundle',
    'create',
    file,
    'HEAD',
    'refs/heads/other',
  ]);
  const mixed = await readFile(file);
  const marker = mixed.indexOf('\n\n');
  expect(marker).toBeGreaterThan(0);
  const hidden = Buffer.concat([
    Buffer.from(`# v2 git bundle\n${f.commit} HEAD\n\n`),
    mixed.subarray(marker + 2),
  ]);
  const selector = {
    base: f.base,
    commit: f.commit,
    tree: f.tree,
    allowlist: [{ kind: 'file' as const, path: 'src/allowed.ts' }],
    maxBundleBytes: mixed.length,
  };
  await expect(verifyParentPrivateSource(f.root, mixed, selector)).rejects.toThrow('pack-format');
  await expect(verifyParentPrivateSource(f.root, hidden, selector)).rejects.toThrow(
    'unreachable-objects',
  );
});

it('rejects a merge with additional reachable history even if the final tree is allowed', async () => {
  const f = await fixture();
  await managedGit(f.repository, ['checkout', '-b', 'other', f.base]);
  await writeFile(path.join(f.repository, 'other.txt'), 'unrelated history\n');
  await managedGit(f.repository, ['add', '--', 'other.txt']);
  await managedGit(f.repository, [...identity, 'commit', '-m', 'Unrelated']);
  const other = await managedGit(f.repository, ['rev-parse', 'HEAD']);
  const merge = await managedGit(f.repository, [
    ...identity,
    'commit-tree',
    f.tree,
    '-p',
    f.base,
    '-p',
    other,
    '-m',
    'Disallowed merge',
  ]);
  await managedGit(f.repository, ['checkout', '--detach', merge]);
  const file = path.join(f.root, 'merge.bundle');
  await managedGit(f.repository, ['-c', 'pack.window=0', 'bundle', 'create', file, 'HEAD']);
  const bundle = await readFile(file);
  await expect(
    verifyParentPrivateSource(f.root, bundle, {
      commit: merge,
      base: f.base,
      tree: f.tree,
      allowlist: [{ kind: 'file', path: 'src/allowed.ts' }],
      maxBundleBytes: bundle.length,
    }),
  ).rejects.toThrow('candidate-path-scope-base-mismatch');
});

it('refuses a small compressed export whose expanded object exceeds the pre-import limit', async () => {
  const f = await fixture('src/allowed.ts', Buffer.alloc(9 * 1024 * 1024, 65));
  expect(f.bundle.length).toBeLessThan(64 * 1024);
  await expect(
    verifyParentPrivateSource(f.root, f.bundle, {
      base: f.base,
      commit: f.commit,
      tree: f.tree,
      allowlist: [{ kind: 'file', path: 'src/allowed.ts' }],
      maxBundleBytes: 64 * 1024,
    }),
  ).rejects.toThrow('object-limit');
});

it('requires an explicit bounded export before creating a verification mirror', async () => {
  const f = await fixture();
  await expect(
    verifyParentPrivateSource(f.root, f.bundle, {
      base: f.base,
      commit: f.commit,
      tree: f.tree,
      allowlist: [{ kind: 'file', path: 'src/allowed.ts' }],
      maxBundleBytes: f.bundle.length - 1,
    }),
  ).rejects.toThrow('parent-private-source-bundle-size');
  await expect(
    verifyParentPrivateSource(f.root, Buffer.alloc(0), {
      base: f.base,
      commit: f.commit,
      tree: f.tree,
      allowlist: [{ kind: 'file', path: 'src/allowed.ts' }],
      maxBundleBytes: 1,
    }),
  ).rejects.toThrow('parent-private-source-bundle-size');
});
