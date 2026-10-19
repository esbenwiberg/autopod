import { describe, expect, it, vi } from 'vitest';
import { createResourceFixture } from '../test-utils/resource-helpers.js';
import { createResourcePreviewTimers } from './resource-preview-timers.js';
describe('preview timer ownership', () => {
  it('replaces and unrefs timers, stops the exact captured target once and leaves no timer', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    f.timers.schedulePreviewAutoStop('prepare', 'old', 'local');
    f.timers.schedulePreviewAutoStop('prepare', 'new', 'sandbox');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600000);
    expect(f.cm.stop).toHaveBeenCalledWith('new');
    expect(f.cm.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels only its own instance and clears its registered entry before failed cleanup', async () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    const stop = vi.fn(async () => {
      throw new Error('Synthetic proxy close');
    });
    const owner = createResourcePreviewTimers({ ...f.core, stopSandboxPreviewProxy: stop });
    owner.schedulePreviewAutoStop('prepare', 'other', 'local');
    f.timers.clearPreviewTimer('prepare');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600000);
    expect(stop).toHaveBeenCalledOnce();
    expect(f.cm.stop).not.toHaveBeenCalled();
    owner.clearPreviewTimer('prepare');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels without container work and does not keep process-exit authority', () => {
    vi.useFakeTimers();
    const f = createResourceFixture();
    const set = vi.spyOn(globalThis, 'setTimeout');
    f.timers.schedulePreviewAutoStop('prepare', 'container', 'local');
    const timer = set.mock.results[0]?.value;
    expect(timer.hasRef()).toBe(false);
    f.timers.clearPreviewTimer('prepare');
    expect(vi.getTimerCount()).toBe(0);
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
});
