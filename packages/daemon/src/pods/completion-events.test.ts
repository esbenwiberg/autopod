import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompletionFixture } from '../test-utils/completion-helpers.js';
const fixtures: ReturnType<typeof createCompletionFixture>[] = [];
function fixture(disk = false) {
  const f = createCompletionFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('completion transitions and event publication', () => {
  it('defers status publication until SQLite commit while refreshing readiness synchronously', () => {
    const f = fixture();
    f.running();
    const order: string[] = [];
    const emit = vi.spyOn(f.deps.eventBus, 'emit');
    f.refreshReadiness.mockImplementation(() => {
      order.push('readiness');
      return true;
    });
    f.podRepo.atomically?.(() => {
      f.events.transition(f.pod(), 'failed', { failureReason: 'Synthetic failure' });
      order.push('inside');
      expect(emit).not.toHaveBeenCalled();
      expect(f.pod().status).toBe('failed');
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pod.status_changed',
        previousStatus: 'running',
        newStatus: 'failed',
      }),
    );
    expect(order).toEqual(['readiness', 'inside']);
  });
  it('publishes no status event when the real transaction rolls back', () => {
    const f = fixture();
    f.running();
    const before = f.pod();
    const emit = vi.spyOn(f.deps.eventBus, 'emit');
    const failure = new Error('Synthetic rollback');
    expect(() =>
      f.podRepo.atomically?.(() => {
        f.events.transition(f.pod(), 'failed');
        throw failure;
      }),
    ).toThrow(failure);
    expect(f.pod()).toEqual(before);
    expect(emit).not.toHaveBeenCalled();
  });
  it('rejects invalid transitions before mutation or publication', () => {
    const f = fixture();
    const before = f.pod();
    const emit = vi.spyOn(f.deps.eventBus, 'emit');
    expect(() => f.events.transition(before, 'complete')).toThrow();
    expect(f.pod()).toEqual(before);
    expect(emit).not.toHaveBeenCalled();
  });
  it('clears the original compromised warning only when completion did not explicitly override it', () => {
    const f = fixture();
    f.running();
    f.podRepo.update('prepare', { worktreeCompromised: true });
    expect(f.events.transition(f.pod(), 'complete').worktreeCompromised).toBe(false);
    f.podRepo.update('prepare', { status: 'running', worktreeCompromised: true });
    expect(
      f.events.transition(f.pod(), 'complete', { worktreeCompromised: true }).worktreeCompromised,
    ).toBe(true);
  });
  it('publishes complete summary defaults and status/error liveness through original references', () => {
    const f = fixture();
    f.running();
    const pod = f.pod();
    const emit = vi.spyOn(f.deps.eventBus, 'emit');
    f.events.emitPodCompletedEvent(pod);
    f.events.emitActivityStatus('prepare', 'status');
    f.events.emitActivityError('prepare', 'failure');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pod.completed',
        summary: expect.objectContaining({ filesChanged: pod.filesChanged, task: pod.task }),
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ type: 'error', fatal: true }) }),
    );
    expect(f.activity.lastEventWriteAt.has('prepare')).toBe(true);
  });
  it('retains rolled-back rows and no status event across private-file SQLite reopen', () => {
    const f = fixture(true);
    f.running();
    const before = f.pod();
    const profile = f.profiles.get('test-profile');
    const count = f.deps.eventRepo.getForSession('prepare').length;
    expect(() =>
      f.podRepo.atomically?.(() => {
        f.events.transition(f.pod(), 'failed');
        throw new Error('Rollback');
      }),
    ).toThrow('Rollback');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(before);
    expect(next.profiles.get('test-profile')).toEqual(profile);
    expect(
      f.db
        .prepare("SELECT count(*) n FROM events WHERE pod_id=? AND type='pod.status_changed'")
        .get('prepare'),
    ).toEqual({ n: count });
  });
});
