import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFixture, deferred } from '../test-utils/workspace-recovery-helpers.js';
describe('workspace durable deletion lifetime', () => {
  it('removes only after verified cleanup and persists deleted visibility/metadata cleanup through SQLite reopen', async () => {
    const f = createWorkspaceFixture(true);
    f.podRepo.update('prepare', { status: 'failed' });
    f.common.pendingUpdateFromBaseIntents.add('prepare');
    f.lease.forceWithLeaseAllowances.add('prepare');
    const profile = f.profiles.get('test-profile');
    await f.deletion().deleteSession('prepare');
    expect(() => f.pod()).toThrow();
    expect(f.cm.kill).toHaveBeenCalledWith('container-123');
    expect(f.common.killSidecarsForPod).toHaveBeenCalledWith(
      'prepare',
      true,
      expect.any(Function),
      true,
    );
    expect(f.common.cleanupTestRunBranches).toHaveBeenCalledWith('prepare', {
      strict: true,
      assertCurrent: expect.any(Function),
      retainMetadata: true,
    });
    expect(f.common.pendingUpdateFromBaseIntents.has('prepare')).toBe(false);
    expect(f.lease.forceWithLeaseAllowances.has('prepare')).toBe(false);
    const next = f.reopen();
    expect(() => next.pods.getOrThrow('prepare')).toThrow();
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('retains failed stage receipts and retries without repeating completed preview cleanup', async () => {
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { status: 'failed' });
    f.common.killSidecarsForPod.mockRejectedValueOnce(new Error('Synthetic sidecar cleanup'));
    await expect(f.deletion().deleteSession('prepare')).rejects.toMatchObject({
      code: 'POD_DELETE_CLEANUP_UNVERIFIED',
    });
    expect(f.pod().containerId).toBe('container-123');
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.common.stopSandboxPreviewProxy).toHaveBeenCalledOnce();
    await f.deletion().deleteSession('prepare');
    expect(() => f.pod()).toThrow();
    expect(f.common.stopSandboxPreviewProxy).toHaveBeenCalledOnce();
  });
  it('uses one25second deadline and admits no later effects after a timed-out stage settles', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { status: 'failed' });
    const gate = deferred();
    f.common.killSidecarsForPod.mockReturnValueOnce(gate.promise);
    const pending = f.deletion().deleteSession('prepare');
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'POD_DELETE_CLEANUP_UNVERIFIED',
    });
    await vi.advanceTimersByTimeAsync(25000);
    await rejected;
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().containerId).toBe('container-123');
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses running work and changing cleanup configuration before destructive stages', async () => {
    const f = createWorkspaceFixture();
    await expect(f.deletion().deleteSession('prepare')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    f.podRepo.update('prepare', { status: 'failed' });
    f.common.killSidecarsForPod.mockImplementationOnce(async () => {
      f.profiles.update('test-profile', {
        testPipeline: {
          enabled: true,
          testRepo: 'https://dev.azure.com/org/project/_git/test',
          testPipelineId: 1,
        },
      });
    });
    await expect(f.deletion().deleteSession('prepare')).rejects.toMatchObject({
      code: 'POD_DELETE_CLEANUP_UNVERIFIED',
    });
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.pod().containerId).toBe('container-123');
  });
});
