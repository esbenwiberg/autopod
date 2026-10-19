import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentExecutionFixture } from '../test-utils/agent-execution-helpers.js';
import { createAgentActivity } from './agent-activity.js';
const fixtures: ReturnType<typeof createAgentExecutionFixture>[] = [];
function fixture(disk = false) {
  const f = createAgentExecutionFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('agent liveness and memory usage', () => {
  it('writes at the exact ten-second boundary and retains the same throttle map', () => {
    const f = fixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    f.activity.bumpActivityTimestamp('prepare');
    const first = f.pod().lastAgentEventAt;
    vi.advanceTimersByTime(9999);
    f.activity.bumpActivityTimestamp('prepare');
    expect(f.pod().lastAgentEventAt).toBe(first);
    vi.advanceTimersByTime(1);
    f.activity.bumpActivityTimestamp('prepare');
    expect(f.pod().lastAgentEventAt).not.toBe(first);
    expect(f.activity.lastEventWriteAt.get('prepare')).toBe(Date.now());
  });
  it('retains best-effort heartbeat and throttle behavior when repository writes fail', () => {
    const f = fixture();
    const update = vi.spyOn(f.podRepo, 'update').mockImplementation(() => {
      throw new Error('Synthetic SQLite unavailable');
    });
    expect(() => f.activity.touchHeartbeat('prepare')).not.toThrow();
    expect(() => f.activity.bumpActivityTimestamp('prepare')).not.toThrow();
    expect(update).toHaveBeenCalledTimes(2);
    expect(f.activity.lastEventWriteAt.has('prepare')).toBe(true);
  });
  it('persists heartbeat through the original repository without changing unrelated profile state', () => {
    const f = fixture();
    const profile = f.profiles.get('test-profile');
    f.activity.touchHeartbeat('prepare');
    expect(f.pod().lastHeartbeatAt).toEqual(expect.any(String));
    expect(f.profiles.get('test-profile')).toEqual(profile);
  });
  it('resolves the live memory usage callback at invocation', () => {
    const f = fixture();
    const record = vi.fn();
    const deps: Parameters<typeof import('./agent-activity.js').createAgentActivity>[0] = {};
    // The actual owner is constructed before installing the late repository below.
    const activity = createAgentActivity(deps, { podRepo: f.podRepo, logger: f.deps.logger });
    deps.memoryUsageRepo = { recordNotReportedForPod: record };
    activity.recordNotReportedMemoryUsage('prepare');
    expect(record).toHaveBeenCalledExactlyOnceWith('prepare');
  });
});
