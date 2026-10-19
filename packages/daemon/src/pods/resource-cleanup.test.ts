import { describe, expect, it, vi } from 'vitest';
import { createResourceFixture, deferred } from '../test-utils/resource-helpers.js';
describe('container resource cleanup lifetime', () => {
  it('retains captured cleanup ordering and persists confirmed sandbox deletion through SQLite reopen', async () => {
    const f = createResourceFixture(true);
    f.sandbox();
    const effects: string[] = [];
    f.cleanupCaptured.stopSandboxPreviewProxy.mockImplementationOnce(async () => {
      effects.push('preview');
    });
    f.live.beforeContainerCleanup = async () => {
      effects.push('memory');
    };
    f.cleanupCaptured.stopHaproxyDenyReceiver.mockImplementationOnce(async () => {
      effects.push('denial');
    });
    vi.mocked(f.cm.kill).mockImplementationOnce(async () => {
      effects.push('kill');
    });
    f.live.launchConfiguration = {
      pim: {
        release: () => {
          effects.push('release');
        },
      },
    };
    const profile = f.profiles.get('test-profile');
    await f.cleanup.cleanupContainer(f.pod(), 'terminal');
    expect(effects).toEqual(['preview', 'memory', 'denial', 'kill', 'release']);
    expect(f.cleanupCaptured.forgetMaxCredentialLineage).toHaveBeenCalledWith('prepare');
    const saved = f.pod();
    expect(saved.containerId).toBeNull();
    const next = f.reopen();
    expect(next.pods.getOrThrow('prepare')).toEqual(saved);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('stops without PIM/lineage release and retains the container identity', async () => {
    const f = createResourceFixture();
    const release = vi.fn();
    f.live.launchConfiguration = { pim: { release } };
    await f.cleanup.cleanupContainer(f.pod(), 'preview', 'stop');
    expect(f.cm.stop).toHaveBeenCalledWith('container-123');
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(f.pod().containerId).toBe('container-123');
    expect(f.cleanupCaptured.forgetMaxCredentialLineage).not.toHaveBeenCalled();
  });
  it('releases live PIM only for current-generation no-container kill', async () => {
    const f = createResourceFixture();
    f.podRepo.update('prepare', { containerId: null });
    const pod = f.pod();
    const release = vi.fn();
    f.live.launchConfiguration = { pim: { release } };
    await f.cleanup.cleanupContainer(pod, 'empty');
    expect(release).toHaveBeenCalledOnce();
    f.podRepo.incrementLifecycleGeneration('prepare');
    await f.cleanup.cleanupContainer(pod, 'stale');
    expect(release).toHaveBeenCalledOnce();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
  it('times out at fifteen seconds, retains identity and lets the original late operation settle', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    const gate = deferred();
    vi.mocked(f.cm.kill).mockReturnValueOnce(gate.promise);
    const pending = f.cleanup.cleanupContainer(f.pod(), 'timeout');
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(f.pod().containerId).toBe('container-123');
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().containerId).toBe('container-123');
  });
  it('bounds memory extraction at twenty seconds and clears the operation timer on completion', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    const hook = deferred();
    f.live.beforeContainerCleanup = () => hook.promise;
    const pending = f.cleanup.cleanupContainer(f.pod(), 'memory');
    await vi.advanceTimersByTimeAsync(19999);
    expect(f.cm.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.cm.kill).toHaveBeenCalledOnce();
    hook.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps replacement sandbox identity when the captured kill finishes', async () => {
    const f = createResourceFixture();
    f.sandbox();
    const gate = deferred();
    vi.mocked(f.cm.kill).mockReturnValueOnce(gate.promise);
    const pending = f.cleanup.cleanupContainer(f.pod(), 'replacement');
    await vi.waitFor(() => expect(f.cm.kill).toHaveBeenCalledOnce());
    f.podRepo.incrementLifecycleGeneration('prepare');
    f.podRepo.update('prepare', { containerId: 'replacement' });
    gate.resolve();
    await pending;
    expect(f.pod().containerId).toBe('replacement');
  });
  it('honors release assertions after preview and leaves failed kill metadata intact', async () => {
    const f = createResourceFixture();
    const error = new Error('Synthetic release veto');
    const guard = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw error;
      });
    await expect(f.cleanup.cleanupContainer(f.pod(), 'guard', 'kill', guard)).rejects.toBe(error);
    expect(f.cm.kill).not.toHaveBeenCalled();
    vi.mocked(f.cm.kill).mockRejectedValueOnce(new Error('Synthetic cleanup'));
    await f.cleanup.cleanupContainer(f.pod(), 'failure');
    expect(f.pod().containerId).toBe('container-123');
  });
});
