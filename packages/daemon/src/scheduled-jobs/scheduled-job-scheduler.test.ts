import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../test-utils/mock-helpers.js';
import { createScheduledJobScheduler } from './scheduled-job-scheduler.js';
import type { ScheduledJobManager } from './scheduled-job-manager.js';

function createMockManager(): ScheduledJobManager {
  return {
    create: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    runCatchup: vi.fn(async () => ({}) as never),
    skipCatchup: vi.fn(),
    trigger: vi.fn(async () => ({}) as never),
    reconcileMissedJobs: vi.fn(),
    tick: vi.fn(async () => {}),
  };
}

describe('ScheduledJobScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls reconcileMissedJobs immediately on start', () => {
    const manager = createMockManager();
    const scheduler = createScheduledJobScheduler(manager, logger);

    scheduler.start();

    expect(manager.reconcileMissedJobs).toHaveBeenCalledOnce();
  });

  it('calls tick after 60 seconds', async () => {
    const manager = createMockManager();
    const scheduler = createScheduledJobScheduler(manager, logger);

    scheduler.start();

    // Tick should not have been called yet
    expect(manager.tick).not.toHaveBeenCalled();

    // Advance timer by 60 seconds
    await vi.advanceTimersByTimeAsync(60_000);

    expect(manager.tick).toHaveBeenCalledOnce();
  });

  it('stop prevents further ticks', async () => {
    const manager = createMockManager();
    const scheduler = createScheduledJobScheduler(manager, logger);

    scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(manager.tick).not.toHaveBeenCalled();
  });

  it('tick errors are caught and do not crash', async () => {
    const manager = createMockManager();
    vi.mocked(manager.tick).mockRejectedValueOnce(new Error('tick error'));

    const scheduler = createScheduledJobScheduler(manager, logger);
    scheduler.start();

    // Should not throw
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
  });
});
