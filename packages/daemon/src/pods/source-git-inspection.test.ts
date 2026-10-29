import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SOURCE_GIT_INSPECTION, parseInspectedSource } from './source-git-inspection.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'source-inspection-'));
  roots.push(root);
  const git = (...args: string[]) =>
    exec('/usr/bin/git', [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-C',
      root,
      ...args,
    ]);
  await git('init', '-b', 'repair');
  await writeFile(path.join(root, '.gitignore'), 'ignored-report\n');
  await writeFile(path.join(root, 'source.txt'), 'pinned');
  await git('add', '.');
  await git('commit', '-m', 'original');
  const inspect = async () =>
    parseInspectedSource(
      (
        await exec('/usr/bin/python3', ['-I', '-c', SOURCE_GIT_INSPECTION, root, 'repair'], {
          env: { ...process.env, GIT_DIR: '/does-not-exist' },
        })
      ).stdout,
      'repair',
    );
  return { root, git, inspect };
}
describe('fixed source Git inspection', () => {
  it('reads the actual branch/commit/tree without repository Python imports or ambient Git overrides', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'json.py'), 'raise Exception("untrusted repository import")');
    await f.git('add', 'json.py');
    await f.git('commit', '-m', 'repository module');
    await writeFile(path.join(f.root, 'ignored-report'), 'untracked report');
    const state = await f.inspect();
    expect(state).toEqual({
      branch: 'repair',
      commitSha: (await f.git('rev-parse', 'HEAD')).stdout.trim(),
      treeSha: (await f.git('rev-parse', 'HEAD^{tree}')).stdout.trim(),
      worktreeClean: true,
    });
  });
  it('reports dirty source rather than resetting or committing it', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, 'source.txt'), 'human work');
    expect((await f.inspect()).worktreeClean).toBe(false);
  });
  it.each(['--assume-unchanged', '--skip-worktree'])(
    'refuses hidden index flags %s',
    async (flag) => {
      const f = await fixture();
      await f.git('update-index', flag, 'source.txt');
      await expect(f.inspect()).rejects.toThrow();
    },
  );
  it('refuses sparse configuration even before skip-worktree flags are materialized', async () => {
    const f = await fixture();
    await f.git('config', 'core.sparseCheckout', 'true');
    await expect(f.inspect()).rejects.toThrow();
  });
  it('refuses repository filters instead of executing checkout-time project code', async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, '.gitattributes'), 'source.txt filter=custom\n');
    await f.git('add', '.gitattributes');
    await f.git('commit', '-m', 'filter attributes');
    const sentinel = path.join(f.root, 'filter-was-executed');
    await f.git('config', 'filter.custom.clean', `touch ${sentinel}`);
    await writeFile(path.join(f.root, 'source.txt'), 'edited source requiring status refresh');
    await expect(f.inspect()).rejects.toThrow();
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requires exact full hashes and parseable bounded metadata', () => {
    const valid = {
      branch: 'repair',
      commitSha: 'a'.repeat(40),
      treeSha: 'b'.repeat(40),
      worktreeClean: true,
    };
    for (const value of [
      { ...valid, branch: 'other' },
      { ...valid, commitSha: 'a'.repeat(41) },
      { ...valid, worktreeClean: 'yes' },
    ])
      expect(() => parseInspectedSource(JSON.stringify(value), 'repair')).toThrow();
    expect(() => parseInspectedSource('not-json', 'repair')).toThrow();
  });
});
