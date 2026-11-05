import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceFixture, deferred } from '../test-utils/workspace-recovery-helpers.js';
import { createEscalationRepository } from './escalation-repository.js';
import { createSessionBridge } from './pod-bridge-impl.js';
import { createPodManager } from './pod-manager.js';
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
  it.each(['preview', 'stop'] as const)(
    'retains a bridge report and unverified run arriving during watchdog %s',
    async (stage) => {
      vi.useFakeTimers();
      const f = createWorkspaceFixture();
      const entered = deferred();
      const gate = deferred();
      const manager = createPodManager(f.ctx.deps);
      f.calls.reconcileInfrastructureBlocker.mockImplementation((id) =>
        manager.reconcileInfrastructureBlocker(id),
      );
      f.podRepo.completionJournal?.begin(f.pod());
      const pod = f.pod();
      const cycle = pod.finalization?.cycle;
      const ledger = f.podRepo.taskExecutions;
      if (!ledger || cycle === undefined) throw new Error('Missing watchdog execution fixture');
      const run = ledger.beginRun(pod.id, pod.lifecycleGeneration, cycle, {
        runtime: pod.runtime,
        model: pod.model,
        providerAccountId: null,
        resource: { containerId: pod.containerId, executionTarget: pod.executionTarget },
      });
      ledger.retainUnverifiedRun(run);
      silent(f);
      const stop = stage === 'preview' ? f.common.stopSandboxPreviewProxy : f.cm.stop;
      vi.mocked(stop).mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
      });
      try {
        f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
        const tick = vi.advanceTimersByTimeAsync(10);
        await entered.promise;
        createSessionBridge({ ...f.ctx.deps, podManager: manager }).createEscalation({
          id: 'late-watchdog-report',
          podId: pod.id,
          type: 'report_blocker',
          timestamp: new Date().toISOString(),
          response: null,
          payload: {
            kind: 'infrastructure',
            requiresResponse: false,
            description: 'Execution remains unresolved',
            attempted: [],
            needs: 'Qualified execution',
          },
        });
        const reported = f.pod();
        gate.resolve();
        await tick;
        await vi.advanceTimersByTimeAsync(0);
        expect(f.pod()).toEqual(reported);
        expect(f.pod()).toMatchObject({
          status: 'running',
          finalization: { sourcePreservedAt: null },
        });
        expect(ledger.hasUnverifiedTermination(pod.id)).toBe(true);
        expect(f.cm.stop).toHaveBeenCalledTimes(stage === 'stop' ? 1 : 0);
        expect(f.calls.reconcileInfrastructureBlocker).toHaveBeenCalledExactlyOnceWith(pod.id);
        expect(f.cm.kill).not.toHaveBeenCalled();
        expect(f.calls.cleanupPodResourcesForRecovery).not.toHaveBeenCalled();
        expect(
          createEscalationRepository(f.db).getOrThrow('late-watchdog-report').response,
        ).toBeNull();
      } finally {
        gate.resolve();
        f.watchdog.stopStuckPodWatchdog();
        vi.useRealTimers();
      }
    },
  );
  it.each([
    { stage: 'preview', change: 'generation' },
    { stage: 'stop', change: 'generation' },
    { stage: 'preview', change: 'heartbeat' },
  ] as const)('retains fresh ownership/activity after watchdog %j', async ({ stage, change }) => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    silent(f);
    const entered = deferred();
    const gate = deferred();
    vi.mocked(
      stage === 'preview' ? f.common.stopSandboxPreviewProxy : f.cm.stop,
    ).mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
    });
    try {
      f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
      const tick = vi.advanceTimersByTimeAsync(10);
      await entered.promise;
      if (change === 'generation') {
        f.podRepo.incrementLifecycleGeneration('prepare');
        f.podRepo.update('prepare', { containerId: 'replacement-container' });
      } else f.podRepo.update('prepare', { lastHeartbeatAt: new Date().toISOString() });
      const current = f.pod();
      gate.resolve();
      await tick;
      await vi.advanceTimersByTimeAsync(0);
      expect(f.pod()).toEqual(current);
      expect(f.cm.stop).toHaveBeenCalledTimes(stage === 'stop' ? 1 : 0);
      expect(f.calls.reconcileInfrastructureBlocker).not.toHaveBeenCalled();
      expect(f.cm.kill).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      f.watchdog.stopStuckPodWatchdog();
      vi.useRealTimers();
    }
  });
  it.each(['fresh', 'silent', 'unverified'] as const)(
    'routes %s current infrastructure to the narrow owner without timeout settlement',
    async (mode) => {
      vi.useFakeTimers();
      const f = createWorkspaceFixture();
      const now = new Date().toISOString();
      f.podRepo.update('prepare', { lastAgentEventAt: now, lastHeartbeatAt: now, startedAt: now });
      if (mode !== 'fresh') silent(f);
      createEscalationRepository(f.db).insert({
        id: 'watchdog-infra',
        podId: 'prepare',
        type: 'report_blocker',
        timestamp: now,
        response: null,
        payload: {
          kind: 'infrastructure',
          requiresResponse: false,
          lifecycleGeneration: f.pod().lifecycleGeneration,
          description: 'Execution needs repair',
          attempted: [],
          needs: 'Qualified execution',
        },
      });
      if (mode === 'unverified')
        f.calls.reconcileInfrastructureBlocker.mockRejectedValueOnce(
          new Error('Bound execution read unavailable'),
        );
      const before = f.pod();
      try {
        f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
        await vi.advanceTimersByTimeAsync(10);
        expect(f.calls.reconcileInfrastructureBlocker).toHaveBeenCalledExactlyOnceWith('prepare');
        expect(f.pod()).toEqual(before);
        expect(f.cm.stop).not.toHaveBeenCalled();
        expect(f.cm.kill).not.toHaveBeenCalled();
        expect(f.calls.cleanupPodResourcesForRecovery).not.toHaveBeenCalled();
        expect(createEscalationRepository(f.db).getOrThrow('watchdog-infra').response).toBeNull();
      } finally {
        f.watchdog.stopStuckPodWatchdog();
        vi.useRealTimers();
      }
    },
  );
  it('does not convert an old-generation report into a current watchdog hold', async () => {
    vi.useFakeTimers();
    const f = createWorkspaceFixture();
    createEscalationRepository(f.db).insert({
      id: 'old-infra',
      podId: 'prepare',
      type: 'report_blocker',
      timestamp: new Date().toISOString(),
      response: null,
      payload: {
        kind: 'infrastructure',
        requiresResponse: false,
        lifecycleGeneration: f.pod().lifecycleGeneration,
        description: 'Old execution',
        attempted: [],
        needs: 'Old need',
      },
    });
    f.podRepo.incrementLifecycleGeneration('prepare');
    silent(f);
    try {
      f.watchdog.startStuckPodWatchdog.call(f.calls, { intervalMs: 10, thresholdMs: 100 });
      await vi.advanceTimersByTimeAsync(10);
      expect(f.calls.reconcileInfrastructureBlocker).not.toHaveBeenCalled();
      expect(f.cm.stop).toHaveBeenCalledExactlyOnceWith('container-123');
      expect(f.pod().status).toBe('failed');
      expect(createEscalationRepository(f.db).getOrThrow('old-infra').response).toBeNull();
    } finally {
      f.watchdog.stopStuckPodWatchdog();
      vi.useRealTimers();
    }
  });
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
