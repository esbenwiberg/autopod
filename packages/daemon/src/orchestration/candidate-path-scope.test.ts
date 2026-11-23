import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { managedGit } from '../managed/source-git.js';
import {
  assertPortableCandidateTree,
  type CandidatePathAllowance,
  validateCandidatePathScope,
} from './candidate-path-scope.js';

const roots: string[] = [];
const identity = [
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@autopod.local',
  '-c',
  'commit.gpgSign=false',
];

interface Fixture {
  repo: string;
  base: string;
  commit(message?: string): Promise<string>;
  request(
    candidate: string,
    allowlist: readonly CandidatePathAllowance[],
  ): Promise<{
    repository: string;
    base: string;
    candidate: string;
    expectedTree: string;
    allowlist: readonly CandidatePathAllowance[];
  }>;
}

async function fixture(): Promise<Fixture> {
  const repo = await mkdtemp(path.join(tmpdir(), 'candidate-path-scope-'));
  roots.push(repo);
  await managedGit(repo, ['init', '-b', 'main']);
  await managedGit(repo, ['config', 'core.filemode', 'true']);
  await writeFile(path.join(repo, 'README.md'), 'base\n');
  await mkdir(path.join(repo, 'src'));
  await writeFile(path.join(repo, 'src', 'tracked.ts'), 'export const value = 1;\n');
  await managedGit(repo, ['add', '--', '.']);
  await managedGit(repo, [...identity, 'commit', '-m', 'base']);
  const base = await managedGit(repo, ['rev-parse', 'HEAD']);
  return {
    repo,
    base,
    async commit(message = 'candidate') {
      await managedGit(repo, ['add', '--all', '--', '.']);
      await managedGit(repo, [...identity, 'commit', '-m', message]);
      return managedGit(repo, ['rev-parse', 'HEAD']);
    },
    async request(candidate, allowlist) {
      return {
        repository: repo,
        base,
        candidate,
        expectedTree: await managedGit(repo, ['rev-parse', `${candidate}^{tree}`]),
        allowlist,
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('validateCandidatePathScope', () => {
  it('accepts regular-file additions, modifications, and deletions within exact and directory grants', async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, 'README.md'), 'changed\n');
    await rm(path.join(f.repo, 'src', 'tracked.ts'));
    await mkdir(path.join(f.repo, 'generated'));
    await writeFile(path.join(f.repo, 'generated', 'result.txt'), 'result\n');
    const candidate = await f.commit();

    await expect(
      validateCandidatePathScope(
        await f.request(candidate, [
          { kind: 'file', path: 'README.md' },
          { kind: 'directory', path: 'src' },
          { kind: 'directory', path: 'generated' },
        ]),
      ),
    ).resolves.toEqual({
      base: f.base,
      candidate,
      tree: await managedGit(f.repo, ['rev-parse', `${candidate}^{tree}`]),
      changedPaths: ['README.md', 'generated/result.txt', 'src/tracked.ts'],
    });
  });

  it('requires an explicit allowlist and rejects a path outside it', async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, 'README.md'), 'changed\n');
    const candidate = await f.commit();
    await expect(validateCandidatePathScope(await f.request(candidate, []))).rejects.toThrow(
      'candidate-path-scope-allowlist-required',
    );
    await expect(
      validateCandidatePathScope(
        await f.request(candidate, [{ kind: 'file', path: 'src/tracked.ts' }]),
      ),
    ).rejects.toThrow('candidate-path-scope-path-not-allowed');
  });

  it('disables rename detection and requires authorization for both deletion and addition', async () => {
    const f = await fixture();
    await rename(path.join(f.repo, 'README.md'), path.join(f.repo, 'MOVED.md'));
    const candidate = await f.commit();
    await expect(
      validateCandidatePathScope(await f.request(candidate, [{ kind: 'file', path: 'MOVED.md' }])),
    ).rejects.toThrow('candidate-path-scope-path-not-allowed');
    await expect(
      validateCandidatePathScope(
        await f.request(candidate, [
          { kind: 'file', path: 'README.md' },
          { kind: 'file', path: 'MOVED.md' },
        ]),
      ),
    ).resolves.toMatchObject({ changedPaths: ['MOVED.md', 'README.md'] });
  });

  it('pins the sole parent and rejects divergent, merge, and empty candidates', async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, 'one.txt'), 'one\n');
    const first = await f.commit('first');

    await managedGit(f.repo, ['checkout', '--detach', f.base]);
    await writeFile(path.join(f.repo, 'two.txt'), 'two\n');
    const divergent = await f.commit('divergent');
    await expect(
      validateCandidatePathScope({
        ...(await f.request(divergent, [{ kind: 'file', path: 'two.txt' }])),
        base: first,
      }),
    ).rejects.toThrow('candidate-path-scope-base-mismatch');

    await managedGit(f.repo, [...identity, 'merge', '--no-ff', '--no-edit', first]);
    const merge = await managedGit(f.repo, ['rev-parse', 'HEAD']);
    await expect(
      validateCandidatePathScope(
        await f.request(merge, [
          { kind: 'file', path: 'one.txt' },
          { kind: 'file', path: 'two.txt' },
        ]),
      ),
    ).rejects.toThrow('candidate-path-scope-base-mismatch');

    await managedGit(f.repo, ['checkout', '--detach', f.base]);
    await managedGit(f.repo, [...identity, 'commit', '--allow-empty', '-m', 'empty']);
    const empty = await managedGit(f.repo, ['rev-parse', 'HEAD']);
    await expect(
      validateCandidatePathScope(await f.request(empty, [{ kind: 'file', path: 'README.md' }])),
    ).rejects.toThrow('candidate-path-scope-changes-required');
  });

  it('pins the expected tree', async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, 'README.md'), 'changed\n');
    const candidate = await f.commit();
    await expect(
      validateCandidatePathScope({
        ...(await f.request(candidate, [{ kind: 'file', path: 'README.md' }])),
        expectedTree: await managedGit(f.repo, ['rev-parse', `${f.base}^{tree}`]),
      }),
    ).rejects.toThrow('candidate-path-scope-tree-mismatch');
  });

  it('preserves an unchanged published Swift extension filename without widening write scopes', async () => {
    const f = await fixture();
    const inheritedName = 'src/Theme+Autopod.swift';
    await writeFile(path.join(f.repo, inheritedName), '// existing extension\n');
    const published = await f.commit('published tree');
    await writeFile(path.join(f.repo, 'README.md'), 'doc change\n');
    const docs = await f.commit('scoped regular path');
    const request = {
      ...(await f.request(docs, [{ kind: 'file', path: 'README.md' }])),
      base: published,
    };
    await expect(validateCandidatePathScope(request)).rejects.toThrow('path-invalid');
    await expect(
      validateCandidatePathScope({ ...request, allowInheritedPublishedEntries: true }),
    ).resolves.toMatchObject({ changedPaths: ['README.md'] });
    await expect(assertPortableCandidateTree(f.repo, docs, published)).resolves.toBeUndefined();
    await writeFile(path.join(f.repo, inheritedName), '// changed extension\n');
    const modified = await f.commit('changed existing name');
    await expect(assertPortableCandidateTree(f.repo, modified, published)).rejects.toThrow(
      'path-invalid',
    );
    await managedGit(f.repo, ['checkout', '--detach', docs]);
    await writeFile(path.join(f.repo, 'src/New+Autopod.swift'), '// unapproved new path\n');
    const added = await f.commit('new nonportable name');
    await expect(assertPortableCandidateTree(f.repo, added, published)).rejects.toThrow(
      'path-invalid',
    );
  });

  it('rejects symlinks, submodules, and tracked mode changes', async () => {
    const symlinkFixture = await fixture();
    await symlink('README.md', path.join(symlinkFixture.repo, 'link'));
    const symlinkCommit = await symlinkFixture.commit('symlink');
    await expect(
      validateCandidatePathScope(
        await symlinkFixture.request(symlinkCommit, [{ kind: 'file', path: 'link' }]),
      ),
    ).rejects.toThrow('candidate-path-scope-mode-invalid');

    const submoduleFixture = await fixture();
    await managedGit(submoduleFixture.repo, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${submoduleFixture.base},nested-repository`,
    ]);
    await managedGit(submoduleFixture.repo, [...identity, 'commit', '-m', 'gitlink']);
    const submoduleCommit = await managedGit(submoduleFixture.repo, ['rev-parse', 'HEAD']);
    await expect(
      validateCandidatePathScope(
        await submoduleFixture.request(submoduleCommit, [
          { kind: 'file', path: 'nested-repository' },
        ]),
      ),
    ).rejects.toThrow('candidate-path-scope-mode-invalid');

    const modeFixture = await fixture();
    await chmod(path.join(modeFixture.repo, 'README.md'), 0o755);
    const modeCommit = await modeFixture.commit('mode');
    await expect(
      validateCandidatePathScope(
        await modeFixture.request(modeCommit, [{ kind: 'file', path: 'README.md' }]),
      ),
    ).rejects.toThrow('candidate-path-scope-mode-invalid');
  });

  it('rejects directory/file path collisions across the base and candidate', async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, 'slot'), 'file\n');
    const withFile = await f.commit('base with file');
    await rm(path.join(f.repo, 'slot'));
    await mkdir(path.join(f.repo, 'slot'));
    await writeFile(path.join(f.repo, 'slot', 'child.txt'), 'child\n');
    const candidate = await f.commit('replace file with directory');
    await expect(
      validateCandidatePathScope({
        ...(await f.request(candidate, [
          { kind: 'file', path: 'slot' },
          { kind: 'file', path: 'slot/child.txt' },
        ])),
        base: withFile,
      }),
    ).rejects.toThrow('candidate-path-scope-path-collision');
  });

  it('rejects a newly added name that aliases an unchanged tracked path', async () => {
    const f = await fixture();
    const blob = await managedGit(f.repo, ['rev-parse', `${f.base}:README.md`]);
    await managedGit(f.repo, [
      '-c',
      'core.ignorecase=false',
      'update-index',
      '--add',
      '--cacheinfo',
      `100644,${blob},readme.md`,
    ]);
    await managedGit(f.repo, [...identity, 'commit', '-m', 'Add alias via index']);
    const candidate = await managedGit(f.repo, ['rev-parse', 'HEAD']);
    await expect(
      validateCandidatePathScope(await f.request(candidate, [{ kind: 'file', path: 'readme.md' }])),
    ).rejects.toThrow('candidate-path-scope-path-collision');
  });

  it('ignores replacement refs while validating frozen commit and tree IDs', async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, 'README.md'), 'authorized\n');
    const authorized = await f.commit('authorized source');
    await managedGit(f.repo, ['checkout', '--detach', f.base]);
    await writeFile(path.join(f.repo, 'README.md'), 'different\n');
    const replacement = await f.commit('replacement source');
    await managedGit(f.repo, ['replace', authorized, replacement]);
    expect(
      await managedGit(f.repo, ['show-ref', '--verify', `refs/replace/${authorized}`]),
    ).toContain(replacement);
    await expect(
      validateCandidatePathScope(
        await f.request(authorized, [{ kind: 'file', path: 'README.md' }]),
      ),
    ).resolves.toMatchObject({ candidate: authorized, changedPaths: ['README.md'] });
  });

  it('rejects invalid or portable-colliding host paths and candidate paths', async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, 'README.md'), 'changed\n');
    const candidate = await f.commit();
    for (const invalid of [
      '../README.md',
      'src/CON.txt',
      'nul',
      'last.',
      'trailing ',
      'alias~1.txt',
      'stream:name',
      'wild*.ts',
      'nön-ascii.ts',
    ]) {
      await expect(
        validateCandidatePathScope(await f.request(candidate, [{ kind: 'file', path: invalid }])),
      ).rejects.toThrow('candidate-path-scope-path-invalid');
    }
    await expect(
      validateCandidatePathScope(
        await f.request(candidate, [
          { kind: 'file', path: 'README.md' },
          { kind: 'directory', path: 'readme.md' },
        ]),
      ),
    ).rejects.toThrow('candidate-path-scope-path-collision');

    const invalid = await fixture();
    await writeFile(path.join(invalid.repo, 'bad\nname.txt'), 'bad\n');
    const invalidCommit = await invalid.commit('invalid path');
    await expect(
      validateCandidatePathScope(
        await invalid.request(invalidCommit, [{ kind: 'directory', path: 'bad' }]),
      ),
    ).rejects.toThrow('candidate-path-scope-path-invalid');
  });
});
