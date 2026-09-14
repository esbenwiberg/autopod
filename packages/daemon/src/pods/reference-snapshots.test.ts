import { expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestContext } from '../test-utils/mock-helpers.js';
import {
  frozenReferenceBindings,
  installReferenceSnapshots,
  stageReferenceSnapshots,
} from './reference-snapshots.js';

it('stages only the frozen commit and installs source as root-owned read-only files', async () => {
  const ctx = createTestContext();
  try {
    const { services } = createTestConfiguration(ctx.db);
    const config = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Research',
        referenceRepositories: [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
      },
      services,
    );
    const archive = Buffer.from('source archive fixture');
    const readSnapshotArchive = vi.fn(async () => archive);
    ctx.deps.worktreeManager.readSnapshotArchive = readSnapshotArchive;
    const allowed = vi.fn(async () => {});
    const staged = await stageReferenceSnapshots(config, ctx.deps.worktreeManager, allowed);
    expect(readSnapshotArchive).toHaveBeenCalledWith({
      repoUrl: 'https://github.com/org/repo-b',
      revision: 'a'.repeat(40),
    });
    expect(frozenReferenceBindings(config)).toEqual([
      { url: 'https://github.com/org/repo-b', mountPath: '1-repo-b' },
    ]);
    expect(allowed).toHaveBeenCalledTimes(2);
    await installReferenceSnapshots(staged, ctx.containerManager, 'container');
    expect(staged.size).toBe(0);
    expect(ctx.containerManager.writeFile).toHaveBeenCalledWith(
      'container',
      '/tmp/.autopod-reference-1-repo-b.tgz',
      archive,
    );
    expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
      'container',
      ['chown', '-R', '0:0', '/repos/1-repo-b'],
      expect.objectContaining({ user: 'root' }),
    );
    expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
      'container',
      ['chmod', '-R', 'a-w', '/repos/1-repo-b'],
      expect.objectContaining({ user: 'root' }),
    );
    expect(
      JSON.stringify(vi.mocked(ctx.containerManager.execInContainer).mock.calls),
    ).not.toContain('git');
  } finally {
    ctx.db.close();
  }
});
it('rejects revocation after fetch before exposing any archive for provisioning', async () => {
  const ctx = createTestContext();
  try {
    const { services } = createTestConfiguration(ctx.db);
    const config = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Research',
        referenceRepositories: [{ repositoryId: 'repo-b', ref: 'main', access: 'read' }],
      },
      services,
    );
    ctx.deps.worktreeManager.readSnapshotArchive = vi.fn(async () => Buffer.from('archive'));
    const allowed = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('revoked'));
    await expect(
      stageReferenceSnapshots(config, ctx.deps.worktreeManager, allowed),
    ).rejects.toThrow('revoked');
    expect(ctx.containerManager.writeFile).not.toHaveBeenCalled();
  } finally {
    ctx.db.close();
  }
});
it('fails provisioning on extraction failure and clears staged source bytes', async () => {
  const ctx = createTestContext();
  try {
    const staged = new Map([['1-repo', Buffer.from('archive')]]);
    vi.mocked(ctx.containerManager.execInContainer).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'failed',
    });
    await expect(
      installReferenceSnapshots(staged, ctx.containerManager, 'container'),
    ).rejects.toMatchObject({ code: 'REFERENCE_INSTALL_FAILED' });
    expect(staged.size).toBe(0);
    expect(ctx.containerManager.execInContainer).toHaveBeenCalledWith(
      'container',
      ['rm', '-f', '/tmp/.autopod-reference-1-repo.tgz'],
      expect.any(Object),
    );
  } finally {
    ctx.db.close();
  }
});
