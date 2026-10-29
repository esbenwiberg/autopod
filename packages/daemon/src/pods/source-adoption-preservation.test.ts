import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockContainerManager } from '../test-utils/mock-helpers.js';
import { verifyArtifactSnapshot } from './artifact-snapshot-receipt.js';
import { preserveSourceWorkspaces } from './source-adoption-preservation.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'source-custody-'));
  roots.push(root);
  const host = path.join(root, 'host');
  const container = path.join(root, 'container');
  for (const directory of [host, container]) {
    await mkdir(path.join(directory, 'node_modules', 'dependency'), { recursive: true });
    await writeFile(path.join(directory, 'code.txt'), 'old code');
    await writeFile(path.join(directory, '.ignored-report.bin'), Buffer.from([0, 1, 255, 42]));
    await writeFile(
      path.join(directory, 'node_modules', 'dependency', 'index.js'),
      'old dependency',
    );
  }
  const cm = createMockContainerManager();
  vi.mocked(cm.extractDirectoryFromContainer).mockImplementation(
    async (_id, _source, destination) => {
      await cp(container, destination, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    },
  );
  const options = {
    containerManager: cm,
    containerId: 'original',
    worktreePath: host,
    archiveRoot: path.join(root, 'archive'),
    generation: 3,
    assertCurrent: () => {},
  };
  return { root, host, container, cm, options };
}
describe('complete source-workspace custody', () => {
  it('captures ignored binary reports and dependencies independently on host and retained resource', async () => {
    const f = await fixture();
    await writeFile(path.join(f.container, 'container-only-report.txt'), 'not on the host');
    const saved = await preserveSourceWorkspaces(f.options);
    for (const snapshot of [saved.host, saved.container]) {
      await verifyArtifactSnapshot(snapshot, path.dirname(snapshot), 3, 0);
      expect(await readFile(path.join(snapshot, '.ignored-report.bin'))).toEqual(
        Buffer.from([0, 1, 255, 42]),
      );
      expect(await readFile(path.join(snapshot, 'node_modules/dependency/index.js'), 'utf8')).toBe(
        'old dependency',
      );
    }
    expect(await readFile(path.join(saved.container, 'container-only-report.txt'), 'utf8')).toBe(
      'not on the host',
    );
    expect(vi.mocked(f.cm.extractDirectoryFromContainer).mock.calls[0]?.[3]).toBeUndefined();
    const guardedExport = vi.mocked(f.cm.extractDirectoryFromContainer).mock.calls[0]?.[4];
    expect(guardedExport?.assertCurrent).toBeTypeOf('function');
    expect(guardedExport?.signal).toBeInstanceOf(AbortSignal);
    await expect(
      verifyArtifactSnapshot(saved.host, path.dirname(saved.host), 4, 0),
    ).rejects.toThrow();
    await writeFile(path.join(saved.host, '.ignored-report.bin'), 'tampered');
    await expect(
      verifyArtifactSnapshot(saved.host, path.dirname(saved.host), 3, 0),
    ).rejects.toThrow();
  });
  it('retains symlink identity, without claiming the external target was archived', async () => {
    const f = await fixture();
    const external = path.join(f.root, 'external-secret');
    await writeFile(external, 'outside workspace');
    await symlink(external, path.join(f.host, 'external-link'));
    const saved = await preserveSourceWorkspaces(f.options);
    expect((await lstat(path.join(saved.host, 'external-link'))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(saved.host, 'external-link'))).toBe(external);
    expect(await readdir(saved.host)).not.toContain('external-secret');
  });
  it('refuses archives inside the source, including an indirect symlink into it', async () => {
    const f = await fixture();
    await expect(
      preserveSourceWorkspaces({ ...f.options, archiveRoot: path.join(f.host, 'archive') }),
    ).rejects.toThrow();
    const link = path.join(f.root, 'link');
    await symlink(f.host, link);
    await expect(
      preserveSourceWorkspaces({ ...f.options, archiveRoot: path.join(link, 'archive') }),
    ).rejects.toThrow();
    expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.host, 'code.txt'), 'utf8')).toBe('old code');
  });
  it('refuses an ancestor or existing archive namespace without chmod or overwrite', async () => {
    const f = await fixture();
    const before = (await lstat(f.root)).mode;
    await expect(preserveSourceWorkspaces({ ...f.options, archiveRoot: f.root })).rejects.toThrow();
    expect((await lstat(f.root)).mode).toBe(before);
    await mkdir(f.options.archiveRoot, { mode: 0o755 });
    await writeFile(path.join(f.options.archiveRoot, 'prior-evidence'), 'keep');
    const oldMode = (await lstat(f.options.archiveRoot)).mode;
    await expect(preserveSourceWorkspaces(f.options)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await lstat(f.options.archiveRoot)).mode).toBe(oldMode);
    expect(await readFile(path.join(f.options.archiveRoot, 'prior-evidence'), 'utf8')).toBe('keep');
    expect(f.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
  });
  it('does not publish a late copy after lifecycle ownership was lost, or delete originals', async () => {
    const f = await fixture();
    let current = true;
    f.options.assertCurrent = () => {
      if (!current) throw new Error('Superseded');
    };
    vi.mocked(f.cm.extractDirectoryFromContainer).mockImplementation(
      async (_id, _source, destination) => {
        await cp(f.container, destination, { recursive: true });
        current = false;
      },
    );
    await expect(preserveSourceWorkspaces(f.options)).rejects.toThrow();
    expect(await readFile(path.join(f.host, 'code.txt'), 'utf8')).toBe('old code');
    expect(await readFile(path.join(f.container, 'code.txt'), 'utf8')).toBe('old code');
    expect(await readdir(path.join(f.options.archiveRoot, 'container'))).toEqual([]);
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
});
