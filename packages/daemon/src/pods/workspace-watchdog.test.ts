import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFixture, deferred } from '../test-utils/workspace-recovery-helpers.js';
const reconcile = vi.hoisted(() =>
  vi.fn<typeof import('./local-reconciler.js')['reconcileLocalSessions']>(async () => ({
    recovered: [],
    killed: [],
    skipped: [],
  })),
);
vi.mock('./local-reconciler.js', () => ({ reconcileLocalSessions: reconcile }));
beforeEach(() => reconcile.mockClear());
function silent(f: ReturnType<typeof createWorkspaceFixture>) {
  const old = new Date(Date.now() - 60000).toISOString();
  f.podRepo.update('prepare', { lastAgentEventAt: old, lastHeartbeatAt: old, startedAt: old });
}
describe('workspace watchdog and wake ownership', () => {
  it('starts idempotently, stops silent automatic work and clears its interval/subscription', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    silent(f);
    f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
    f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.cm.stop).toHaveBeenCalledWith('container-123');
    expect(f.pod().status).toBe('failed');
    f.watchdog.stopStuckPodWatchdog();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('excludes interactive pods and uses the freshest heartbeat for automatic work', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    silent(f);
    f.interactive();
    f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
    await vi.advanceTimersByTimeAsync(20);
    expect(f.pod().status).toBe('running');
    expect(f.cm.stop).not.toHaveBeenCalled();
    f.watchdog.stopStuckPodWatchdog();
    f.podRepo.update('prepare', {
      options: { agentMode: 'auto', output: 'pr', validate: true, promotable: false },
      lastHeartbeatAt: new Date().toISOString(),
    });
    f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
    await vi.advanceTimersByTimeAsync(20);
    expect(f.pod().status).toBe('running');
    expect(f.cm.stop).not.toHaveBeenCalled();
    f.watchdog.stopStuckPodWatchdog();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('deduplicates wake publication, reads live configuration and resolves deferred receiver properties', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    silent(f);
    const gate = deferred();
    reconcile.mockImplementationOnce(async (deps) => {
      await gate.promise;
      await deps.finishCancelledGoal?.('prepare');
      await deps.cleanupPodResources?.('prepare');
      return { recovered: [], killed: [], skipped: [] };
    });
    f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
    const get = vi.fn(() => null);
    f.live.launchConfiguration = { goals: { get } };
    f.deps.eventBus.emit({
      type: 'host.resumed',
      timestamp: '2026-10-19T08:00:00Z',
      sleptMs: 1000,
      detector: 'tick-gap',
      reconciledPodIds: [],
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]?.[0].readNativeGoal).toBe(get);
    const kill = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    f.calls.killSession = kill;
    f.calls.cleanupPodResourcesForRecovery = cleanup;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(kill).toHaveBeenCalledWith('prepare');
    expect(cleanup).toHaveBeenCalledWith('prepare');
    expect(reconcile).toHaveBeenCalledOnce();
    expect(f.pod().status).toBe('running');
    f.watchdog.stopStuckPodWatchdog();
    f.deps.eventBus.emit({
      type: 'host.resumed',
      timestamp: '2026-10-19T08:01:00Z',
      sleptMs: 1000,
      detector: 'tick-gap',
      reconciledPodIds: [],
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops new admissions while already-dispatched wake work retains its original continuation', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    const gate = deferred();
    reconcile.mockImplementationOnce(async (deps) => {
      await gate.promise;
      await deps.cleanupPodResources?.('prepare');
      return { recovered: [], killed: [], skipped: [] };
    });
    f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
    f.deps.eventBus.emit({
      type: 'host.resumed',
      timestamp: '2026-10-19T09:00:00Z',
      sleptMs: 1000,
      detector: 'tick-gap',
      reconciledPodIds: [],
    });
    f.watchdog.stopStuckPodWatchdog();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls.cleanupPodResourcesForRecovery).not.toHaveBeenCalled();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls.cleanupPodResourcesForRecovery).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });
});
