import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPinnedAdoption,
  inspectAdoptionGit,
  preparePinnedAdoption,
} from './source-adoption-git.js';
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'source-adoption-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const local = path.join(root, 'local');
  await exec('git', ['init', '--bare', origin]);
  await exec('git', ['clone', origin, local]);
  const git = (args: string[]) =>
    exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: local,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_GRAFT_FILE: '/dev/null',
      },
    });
  await git(['checkout', '-b', 'repair']);
  await writeFile(path.join(local, '.gitignore'), 'ignored-report.txt\n');
  await writeFile(path.join(local, 'code.txt'), 'old\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'old']);
  const old = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await git(['push', 'origin', 'repair']);
  await writeFile(path.join(local, 'code.txt'), 'repaired\n');
  await git(['commit', '-am', 'repair']);
  const target = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  await git(['push', 'origin', 'repair']);
  await git(['reset', '--hard', old]);
  await writeFile(path.join(local, 'ignored-report.txt'), 'original report bytes');
  const config = {
    worktreePath: local,
    repository: 'https://github.com/org/repo',
    branch: 'repair',
    oldHead: old,
    targetHead: target,
    id: 'test-intent',
    bundle: path.join(root, 'preserved.bundle'),
    assertCurrent() {},
  };
  const prepare = () =>
    preparePinnedAdoption(config, git, async (ref) => {
      await git(['fetch', origin, `+refs/heads/repair:${ref}`]);
    });
  return { root, local, git, old, target, config, prepare };
}
describe('real Git exact-source adoption', () => {
  it('refuses repository-local executable filters before status can invoke them', async () => {
    const f = await fixture();
    await writeFile(path.join(f.local, '.gitattributes'), 'code.txt filter=source-policy\n');
    await f.git(['add', '.gitattributes']);
    await f.git(['commit', '-m', 'fixture attributes']);
    const sentinel = path.join(f.root, 'filter-must-not-execute');
    await f.git(['config', 'filter.source-policy.clean', `touch ${sentinel}`]);
    await writeFile(path.join(f.local, 'code.txt'), 'changed source requiring status refresh');
    await expect(inspectAdoptionGit(f.git, 'repair')).rejects.toThrow('Executable filters');
    await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('pins remote source without changing workspace, then fast-forwards without deleting ignored reports', async () => {
    const f = await fixture();
    const saved = await f.prepare();
    expect((await inspectAdoptionGit(f.git, 'repair')).head).toBe(f.old);
    await f.git(['bundle', 'verify', saved.bundle]);
    const recovered = path.join(f.root, 'recovered.git');
    await exec('git', ['clone', '--mirror', saved.bundle, recovered]);
    expect(
      (await exec('git', ['rev-parse', `${f.old}^{tree}`], { cwd: recovered })).stdout.trim(),
    ).not.toBe('');
    expect(
      (await exec('git', ['rev-parse', `${f.target}^{tree}`], { cwd: recovered })).stdout.trim(),
    ).toBe(saved.tree);
    await applyPinnedAdoption(f.config, f.git);
    expect((await inspectAdoptionGit(f.git, 'repair')).head).toBe(f.target);
    expect(await readFile(path.join(f.local, 'code.txt'), 'utf8')).toBe('repaired\n');
    expect(await readFile(path.join(f.local, 'ignored-report.txt'), 'utf8')).toBe(
      'original report bytes',
    );
    expect(
      (await f.git(['rev-parse', 'refs/autopod/source-adoption/test-intent/old'])).stdout.trim(),
    ).toBe(f.old);
  });
  it('refuses to overwrite an ignored report that the newer source starts tracking', async () => {
    const f = await fixture();
    await f.git(['checkout', f.target]);
    await writeFile(path.join(f.local, 'ignored-report.txt'), 'new tracked template');
    await f.git(['add', '-f', 'ignored-report.txt']);
    await f.git(['commit', '-m', 'track report template']);
    f.config.targetHead = (await f.git(['rev-parse', 'HEAD'])).stdout.trim();
    await f.git(['branch', '-f', 'repair', f.config.targetHead]);
    await f.git(['push', 'origin', 'repair']);
    await f.git(['checkout', 'repair']);
    await f.git(['reset', '--hard', f.old]);
    await writeFile(path.join(f.local, 'ignored-report.txt'), 'original report bytes');
    await f.prepare();
    await expect(applyPinnedAdoption(f.config, f.git)).rejects.toThrow();
    expect((await inspectAdoptionGit(f.git, 'repair')).head).toBe(f.old);
    expect(await readFile(path.join(f.local, 'ignored-report.txt'), 'utf8')).toBe(
      'original report bytes',
    );
  });
  it('never overwrites older custody evidence at the destination path', async () => {
    const f = await fixture();
    await writeFile(f.config.bundle, 'previous custody evidence');
    await expect(f.prepare()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(f.config.bundle, 'utf8')).toBe('previous custody evidence');
    expect((await inspectAdoptionGit(f.git, 'repair')).head).toBe(f.old);
  });
  it('refuses mutation without a matching pinned custody bundle', async () => {
    const f = await fixture();
    await expect(applyPinnedAdoption(f.config, f.git)).rejects.toThrow();
    expect((await inspectAdoptionGit(f.git, 'repair')).head).toBe(f.old);
  });
  it('refuses remote advancement instead of silently adopting a different commit', async () => {
    const f = await fixture();
    f.config.targetHead = 'c'.repeat(40);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'SOURCE_REMOTE_CHANGED' });
    expect((await inspectAdoptionGit(f.git, 'repair')).head).toBe(f.old);
  });
  it('refuses dirty source rather than discarding it with hard reset or clean', async () => {
    const f = await fixture();
    await writeFile(path.join(f.local, 'code.txt'), 'unsaved human work');
    await expect(f.prepare()).rejects.toThrow();
    expect(await readFile(path.join(f.local, 'code.txt'), 'utf8')).toBe('unsaved human work');
  });
  it('does not mistake assume-unchanged files for clean current source', async () => {
    const f = await fixture();
    await f.git(['update-index', '--assume-unchanged', 'code.txt']);
    await writeFile(path.join(f.local, 'code.txt'), 'hidden source drift');
    expect((await f.git(['status', '--porcelain'])).stdout).toBe('');
    await expect(f.prepare()).rejects.toThrow('assume-unchanged');
    expect(await readFile(path.join(f.local, 'code.txt'), 'utf8')).toBe('hidden source drift');
  });
  it('rechecks ownership after fetch and refuses any workspace mutation on cancellation', async () => {
    const f = await fixture();
    let current = true;
    f.config.assertCurrent = () => {
      if (!current) throw new Error('Superseded');
    };
    await expect(
      preparePinnedAdoption(f.config, f.git, async (ref) => {
        await f.git(['fetch', 'origin', `+refs/heads/repair:${ref}`]);
        current = false;
      }),
    ).rejects.toThrow('Superseded');
    expect((await inspectAdoptionGit(f.git, 'repair')).head).toBe(f.old);
  });
});
