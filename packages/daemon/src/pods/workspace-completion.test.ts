import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPimClient } from '../actions/handlers/azure-pim-handler.js';
import { createWorkspaceFixture, deferred } from '../test-utils/workspace-recovery-helpers.js';
const pim = vi.hoisted(() => ({ deactivate: vi.fn(async () => {}) }));
vi.mock('../actions/handlers/azure-pim-handler.js', () => ({ createPimClient: vi.fn(() => pim) }));
describe('complete workspace completion lifetime', () => {
  it('syncs and publishes before cleanup and persists completed state through actual SQLite reopen', async () => {
    const f = createWorkspaceFixture(true);
    f.interactive();
    const effects: string[] = [];
    f.common.syncWorkspaceBack.mockImplementationOnce(async () => {
      effects.push('sync');
      return { pushed: true };
    });
    vi.mocked(f.worktreeManager.mergeBranch).mockImplementationOnce(async () => {
      effects.push('push');
    });
    vi.mocked(f.worktreeManager.cleanup).mockImplementationOnce(async () => {
      effects.push('worktree cleanup');
    });
    await expect(f.completion().completeSession.call(f.calls, 'prepare')).resolves.toEqual({
      pushError: undefined,
    });
    expect(effects).toEqual(['sync', 'push', 'worktree cleanup']);
    expect(f.worktreeManager.mergeBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBranch: 'branch',
        maxDeletions: 100,
        pat: 'synthetic-git-key',
      }),
    );
    expect(f.cm.kill).toHaveBeenCalledWith('container-123');
    expect(f.pod().status).toBe('complete');
    const saved = f.pod();
    const profile = f.profiles.get('test-profile');
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('retains physical source and running state on sync preservation failure through reopen', async () => {
    const f = createWorkspaceFixture(true);
    f.interactive();
    const filename = path.join(f.directory, 'uncommitted.txt');
    writeFileSync(filename, 'Retained human edits');
    f.common.syncWorkspaceBack.mockRejectedValueOnce(new Error('Synthetic sync failure'));
    await expect(f.completion().completeSession.call(f.calls, 'prepare')).rejects.toMatchObject({
      code: 'WORKSPACE_PRESERVATION_FAILED',
    });
    expect(f.pod()).toMatchObject({
      status: 'running',
      containerId: 'container-123',
      worktreePath: f.directory,
    });
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(readFileSync(filename, 'utf8')).toBe('Retained human edits');
    const saved = f.pod();
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(readFileSync(filename, 'utf8')).toBe('Retained human edits');
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('returns pushError and preserves the worktree when publication fails, using the original completion policy', async () => {
    const f = createWorkspaceFixture();
    f.interactive();
    vi.mocked(f.worktreeManager.mergeBranch).mockRejectedValueOnce(
      new Error('Synthetic push refused'),
    );
    await expect(f.completion().completeSession.call(f.calls, 'prepare')).resolves.toEqual({
      pushError: 'Synthetic push refused',
    });
    expect(f.pod()).toMatchObject({ status: 'complete', worktreePath: f.directory });
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
  });
  it('keeps original default-branch refusal as a returned pushError without publishing or deleting the worktree', async () => {
    const f = createWorkspaceFixture();
    f.interactive();
    f.podRepo.update('prepare', { baseBranch: 'branch' });
    await expect(f.completion().completeSession.call(f.calls, 'prepare')).resolves.toMatchObject({
      pushError: expect.stringContaining('default branch'),
    });
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.worktreeManager.cleanup).not.toHaveBeenCalled();
  });
  it('coalesces identical API work and fences a replacement after deferred sync', async () => {
    const f = createWorkspaceFixture();
    f.interactive();
    const gate = deferred<{ pushed: boolean }>();
    f.common.syncWorkspaceBack.mockReturnValueOnce(gate.promise);
    const owner = f.completion();
    const first = owner.completeSession.call(f.calls, 'prepare');
    const second = owner.completeSession.call(f.calls, 'prepare');
    const a = expect(first).rejects.toMatchObject({ code: 'STALE_WORKSPACE_COMPLETION' });
    const b = expect(second).rejects.toMatchObject({ code: 'STALE_WORKSPACE_COMPLETION' });
    await vi.waitFor(() => expect(f.common.syncWorkspaceBack).toHaveBeenCalledOnce());
    f.podRepo.incrementLifecycleGeneration('prepare');
    f.podRepo.update('prepare', { containerId: 'replacement' });
    gate.resolve({ pushed: true });
    await a;
    await b;
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.pod()).toMatchObject({ status: 'running', containerId: 'replacement' });
  });
  it('routes coordinated promotion through the actual receiver instead of completing directly', async () => {
    const f = createWorkspaceFixture();
    f.interactive();
    const promote = vi.fn(async () => {});
    const pending = f.completion().completeSession.call(f.calls, 'prepare', {
      promoteTo: 'artifact',
      instructions: 'handoff',
      skipAgent: true,
    });
    f.calls.promoteToAuto = promote;
    await expect(pending).resolves.toEqual({ promotedTo: 'artifact' });
    expect(promote).toHaveBeenCalledWith('prepare', 'artifact', {
      instructions: 'handoff',
      skipAgent: true,
    });
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('retains resources when artifact preservation fails', async () => {
    const f = createWorkspaceFixture();
    f.interactive('artifact');
    const error = new Error('Synthetic artifact copy');
    f.common.preserveArtifacts.mockRejectedValueOnce(error);
    await expect(f.completion().completeSession.call(f.calls, 'prepare')).rejects.toBe(error);
    expect(f.pod().status).toBe('running');
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
  });
});
it('uses the live secret resolver and keeps PIM deactivation failure best effort after completion', async () => {
  const f = createWorkspaceFixture();
  f.podRepo.insert({
    id: 'pim-workspace',
    profileName: 'test-profile',
    task: 'PIM workspace',
    status: 'running',
    runtime: 'claude',
    model: f.pod().model,
    executionTarget: 'local',
    branch: 'pim',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'workspace',
    options: { agentMode: 'interactive', output: 'none', validate: false, promotable: true },
    pimGroups: [{ groupId: 'synthetic-group' }],
  });
  f.podRepo.update('pim-workspace', { containerId: 'pim-container', worktreePath: f.directory });
  const owner = f.completion();
  const getSecret = vi.fn(() => undefined);
  f.live.getSecret = getSecret;
  pim.deactivate.mockRejectedValueOnce(new Error('Synthetic PIM'));
  await owner.completeSession.call(f.calls, 'pim-workspace');
  expect(createPimClient).toHaveBeenCalledWith(getSecret, f.deps.logger);
  expect(pim.deactivate).toHaveBeenCalledWith('synthetic-group', 'operator');
  expect(f.podRepo.getOrThrow('pim-workspace').status).toBe('complete');
});
it('looks up linked revalidation on the original receiver after an awaited push replaces the method', async () => {
  const f = createWorkspaceFixture();
  f.podRepo.update('prepare', { status: 'failed' });
  f.podRepo.insert({
    id: 'linked-workspace',
    profileName: 'test-profile',
    task: 'Manual repair',
    status: 'running',
    runtime: 'claude',
    model: f.pod().model,
    executionTarget: 'local',
    branch: 'repair',
    baseBranch: 'main',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'workspace',
    linkedPodId: 'prepare',
  });
  f.podRepo.update('linked-workspace', {
    containerId: 'linked-container',
    worktreePath: f.directory,
  });
  const original = f.calls.revalidateSession;
  const replacement = vi.fn(async () => ({ newCommits: false, result: 'pass' as const }));
  vi.mocked(f.worktreeManager.mergeBranch).mockImplementationOnce(async () => {
    f.calls.revalidateSession = replacement;
  });
  await f.completion().completeSession.call(f.calls, 'linked-workspace');
  expect(replacement).toHaveBeenCalledWith('prepare');
  expect(original).not.toHaveBeenCalled();
  expect(f.podRepo.getOrThrow('linked-workspace').status).toBe('complete');
});
