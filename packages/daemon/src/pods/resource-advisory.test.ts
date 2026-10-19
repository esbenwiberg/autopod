import type { ValidationResult } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createResourceFixture, deferred } from '../test-utils/resource-helpers.js';
import { createAdvisoryValidation } from './advisory-validation.js';
import { createResourceAdvisoryCleanup, createResourceAdvisoryState } from './resource-advisory.js';
import { createValidationProgress } from './validation-progress.js';
describe('resource advisory ownership', () => {
  it('owns one instance map and transfers a single FIFO slot without opening capacity early', async () => {
    const a = createResourceAdvisoryState();
    const b = createResourceAdvisoryState();
    expect(a.advisoryRuns).not.toBe(b.advisoryRuns);
    const seen: number[] = [];
    await a.acquireAdvisoryQaSlot();
    const second = a.acquireAdvisoryQaSlot().then(() => {
      seen.push(2);
    });
    const third = a.acquireAdvisoryQaSlot().then(() => {
      seen.push(3);
    });
    await Promise.resolve();
    expect(seen).toEqual([]);
    a.releaseAdvisoryQaSlot();
    await second;
    expect(seen).toEqual([2]);
    a.releaseAdvisoryQaSlot();
    await third;
    expect(seen).toEqual([2, 3]);
    a.releaseAdvisoryQaSlot();
    await a.acquireAdvisoryQaSlot();
    a.releaseAdvisoryQaSlot();
    await b.acquireAdvisoryQaSlot();
    b.releaseAdvisoryQaSlot();
  });
  it('returns the original cleanup promise when no advisory is registered and rejects guidance first', async () => {
    const f = createResourceFixture();
    const gate = deferred();
    const cleanup = vi.fn(() => gate.promise);
    const owner = createResourceAdvisoryCleanup({
      ...f.core,
      ...f.advisory,
      cleanupContainer: cleanup,
    });
    const returned = owner.cleanupContainerAfterAdvisorySettles(f.pod(), 'direct');
    expect(returned).toBe(gate.promise);
    gate.resolve();
    await returned;
    f.deps.nudgeRepo.queue('prepare', 'Uncollected instruction');
    expect(() => owner.cleanupContainerAfterAdvisorySettles(f.pod(), 'blocked')).toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it.each(['resolve', 'reject'] as const)(
    'defers cleanup until tracked advisory %s while returning immediately',
    async (outcome) => {
      const f = createResourceFixture();
      const gate = deferred<ValidationResult>();
      f.advisory.advisoryRuns.set('prepare', gate.promise);
      const cleanup = vi.fn(async () => {});
      const owner = createResourceAdvisoryCleanup({
        ...f.core,
        ...f.advisory,
        cleanupContainer: cleanup,
      });
      const captured = f.pod();
      await owner.cleanupContainerAfterAdvisorySettles(captured, 'deferred', 'stop');
      expect(cleanup).not.toHaveBeenCalled();
      if (outcome === 'resolve') gate.resolve(f.pod().lastValidationResult as ValidationResult);
      else gate.reject(new Error('Synthetic advisory failure'));
      await vi.waitFor(() =>
        expect(cleanup).toHaveBeenCalledWith(captured, 'deferred', 'stop', undefined),
      );
    },
  );
  it('catches detached cleanup failure and the slot is reusable after failure release', async () => {
    const f = createResourceFixture();
    const gate = deferred<ValidationResult>();
    f.advisory.advisoryRuns.set('prepare', gate.promise);
    const cleanup = vi.fn(async () => {
      throw new Error('Synthetic deferred cleanup');
    });
    const owner = createResourceAdvisoryCleanup({
      ...f.core,
      ...f.advisory,
      cleanupContainer: cleanup,
    });
    await f.advisory.acquireAdvisoryQaSlot();
    try {
      throw new Error('Synthetic advisory');
    } catch {
    } finally {
      f.advisory.releaseAdvisoryQaSlot();
    }
    await f.advisory.acquireAdvisoryQaSlot();
    f.advisory.releaseAdvisoryQaSlot();
    await owner.cleanupContainerAfterAdvisorySettles(f.pod(), 'failure');
    gate.resolve(f.pod().lastValidationResult as ValidationResult);
    await vi.waitFor(() =>
      expect(f.deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ podId: 'prepare' }),
        'Deferred container cleanup after advisory QA failed',
      ),
    );
  });
});

it('shares the resource semaphore/map with actual advisory execution and releases/deletes after runner failure', async () => {
  const f = createResourceFixture();
  f.podRepo.update('prepare', { status: 'validated' });
  const expected = f.pod();
  const blocking = expected.lastValidationResult;
  if (!blocking) throw new Error('Missing blocking result');
  const gate = deferred();
  const runner = vi.fn(async () => {
    await gate.promise;
    throw new Error('Synthetic advisory runner');
  });
  const progress = createValidationProgress({ eventBus: f.deps.eventBus });
  const owner = createAdvisoryValidation({
    podRepo: f.podRepo,
    nudgeRepo: f.deps.nudgeRepo,
    validationEngine: { runAdvisoryBrowserQa: runner },
    logger: f.deps.logger,
    ...f.advisory,
    ...progress,
    refreshReadiness: vi.fn(() => true),
    emitActivityStatus: f.core.emitActivityStatus,
  });
  const run = owner.runAdvisoryAfterValidation(
    'prepare',
    {
      podId: 'prepare',
      containerId: 'container-123',
      previewUrl: 'http://fixture.invalid',
      buildCommand: 'build',
      startCommand: 'start',
      healthPath: '/',
      healthTimeout: 10,
      smokePages: [],
      attempt: blocking.attempt,
      task: expected.task,
      diff: 'synthetic',
    },
    blocking,
    undefined,
    expected,
  );
  expect(f.advisory.advisoryRuns.has('prepare')).toBe(true);
  await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
  let transferred = false;
  const waiting = f.advisory.acquireAdvisoryQaSlot().then(() => {
    transferred = true;
  });
  await Promise.resolve();
  expect(transferred).toBe(false);
  gate.resolve();
  await expect(run).resolves.toBe(blocking);
  await waiting;
  expect(transferred).toBe(true);
  f.advisory.releaseAdvisoryQaSlot();
  expect(f.advisory.advisoryRuns.size).toBe(0);
  await f.advisory.acquireAdvisoryQaSlot();
  f.advisory.releaseAdvisoryQaSlot();
});
