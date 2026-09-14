import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';

it('publishes an existing workspace branch even when no new Markdown files need committing', async () => {
  const ctx = createTestContext();
  const directory = mkdtempSync(join(tmpdir(), 'autopod-workspace-publish-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Workspace', outputMode: 'workspace' },
      'operator',
    );
    await manager.processPod(pod.id);
    expect(manager.getSession(pod.id).status).toBe('running');
    ctx.podRepo.update(pod.id, { worktreePath: directory, containerId: null });
    vi.mocked(ctx.worktreeManager.commitFiles).mockClear();
    vi.mocked(ctx.worktreeManager.pushBranch).mockClear();
    const result = await manager.syncWorkspaceBranch(pod.id);
    expect(result).toEqual({ committed: false, pushed: true });
    expect(ctx.worktreeManager.commitFiles).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.pushBranch).toHaveBeenCalledWith(
      directory,
      pod.branch,
      expect.any(Object),
    );
    expect(manager.getSession(pod.id).status).toBe('running');
  } finally {
    ctx.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not commit or publish stale host files after workspace synchronization fails', async () => {
  const ctx = createTestContext();
  try {
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Workspace', outputMode: 'workspace' },
      'operator',
    );
    await manager.processPod(pod.id);
    expect(manager.getSession(pod.id).status).toBe('running');
    ctx.podRepo.update(pod.id, {
      worktreePath: '/fixture/workspace',
      containerId: 'fixture-container',
    });
    vi.mocked(ctx.worktreeManager.commitFiles).mockClear();
    vi.mocked(ctx.worktreeManager.pushBranch).mockClear();
    vi.mocked(ctx.deps.containerManagerFactory.get).mockImplementation(() => {
      throw new Error('Fixture transport unavailable');
    });
    expect(await manager.syncWorkspaceBranch(pod.id)).toMatchObject({
      committed: false,
      pushed: false,
      error: expect.stringContaining('synchronization failed'),
    });
    expect(ctx.worktreeManager.commitFiles).not.toHaveBeenCalled();
    expect(ctx.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(manager.getSession(pod.id).containerId).toBe('fixture-container');
  } finally {
    ctx.db.close();
  }
});

it('includes authored contracts and preserves unusual handoff filenames without selecting other source', async () => {
  const ctx = createTestContext();
  const directory = mkdtempSync(join(tmpdir(), 'autopod-workspace-contract-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    mkdirSync(join(directory, 'specs'));
    const files = ['brief.md', 'specs/contract.yaml', 'specs/space\nand tab.md'];
    for (const file of [...files, 'unrelated.ts', 'other.yaml'])
      writeFileSync(join(directory, file), 'fixture');
    const manager = createPodManager(ctx.deps);
    const pod = manager.createSession(
      { profileName: 'test-profile', task: 'Workspace', outputMode: 'workspace' },
      'operator',
    );
    await manager.processPod(pod.id);
    ctx.podRepo.update(pod.id, { worktreePath: directory, containerId: null });
    vi.mocked(ctx.worktreeManager.commitFiles).mockClear();
    await manager.syncWorkspaceBranch(pod.id);
    expect(vi.mocked(ctx.worktreeManager.commitFiles).mock.calls[0]?.[1]?.sort()).toEqual(
      files.sort(),
    );
  } finally {
    ctx.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
