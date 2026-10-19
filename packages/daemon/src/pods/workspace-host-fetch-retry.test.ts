import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceFixture } from '../test-utils/workspace-recovery-helpers.js';
import { GitTransientFetchError } from '../worktrees/local-worktree-manager.js';
describe('workspace host-fetch retry timers', () => {
  it('persists30/120/300second retry identity, replaces timer and enqueues only latest deadline', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { status: 'queued' });
    const owner = f.hostRetry();
    const error = new GitTransientFetchError('main', 'base', 'Synthetic timeout');
    owner.scheduleHostFetchRetry(f.pod(), error);
    expect(f.pod().infrastructureFailure).toMatchObject({ source: 'git-fetch', attemptCount: 1 });
    await vi.advanceTimersByTimeAsync(29999);
    expect(f.common.enqueueSession).not.toHaveBeenCalled();
    owner.scheduleHostFetchRetry(f.pod(), error);
    expect(vi.getTimerCount()).toBe(1);
    expect(f.pod().infrastructureFailure).toMatchObject({ attemptCount: 2 });
    await vi.advanceTimersByTimeAsync(120000);
    expect(f.common.enqueueSession).toHaveBeenCalledOnce();
    owner.scheduleHostFetchRetry(f.pod(), error);
    expect(f.pod().infrastructureFailure).toMatchObject({ attemptCount: 3 });
    await vi.advanceTimersByTimeAsync(300000);
    expect(f.common.enqueueSession).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('restarts count for different branch/purpose and refuses stale state on fire', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    f.podRepo.update('prepare', { status: 'queued' });
    const owner = f.hostRetry();
    owner.scheduleHostFetchRetry(f.pod(), new GitTransientFetchError('one', 'base', 'synthetic'));
    owner.scheduleHostFetchRetry(f.pod(), new GitTransientFetchError('two', 'start', 'synthetic'));
    expect(f.pod().infrastructureFailure).toMatchObject({
      attemptCount: 1,
      branch: 'two',
      purpose: 'start',
    });
    f.podRepo.update('prepare', { status: 'running' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.common.enqueueSession).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains retry evidence through an actual SQLite reopen and leaves no timer', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture(true);
    f.podRepo.update('prepare', { status: 'queued' });
    f.hostRetry().scheduleHostFetchRetry(
      f.pod(),
      new GitTransientFetchError('main', 'base', 'synthetic'),
    );
    await vi.advanceTimersByTimeAsync(30000);
    const saved = f.pod();
    const profile = f.profiles.get('test-profile');
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
