import { afterEach, expect, it, vi } from 'vitest';
import { type PollOwnership, createPollingCoordinator } from './polling-coordinator.js';

afterEach(() => vi.useRealTimers());

it('drains an old owner before its replacement and ignores the old stop request', async () => {
  vi.useFakeTimers();
  const errors = vi.fn();
  const coordinator = createPollingCoordinator(errors);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let old: PollOwnership | undefined;
  const first = vi.fn(async (owner: PollOwnership) => {
    old = owner;
    await gate;
    owner.stop();
  });
  const replacement = vi.fn(async () => {});
  coordinator.start('pod', 5_000, first);
  await vi.advanceTimersByTimeAsync(0);
  coordinator.start('pod', 5_000, replacement);
  expect(old?.isCurrent()).toBe(false);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(first).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(replacement).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(replacement).toHaveBeenCalledTimes(2);
  expect(errors).not.toHaveBeenCalled();
  coordinator.stop('pod');
});

it('releases a failed operation for a later tick without blocking other pods', async () => {
  vi.useFakeTimers();
  const errors = vi.fn();
  const coordinator = createPollingCoordinator(errors);
  let reject = (_error: Error) => {};
  const gate = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const first = vi
    .fn()
    .mockImplementationOnce(() => gate)
    .mockResolvedValue(undefined);
  const other = vi.fn(async () => {});
  coordinator.start('first', 5_000, first);
  coordinator.start('other', 5_000, other);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(first).toHaveBeenCalledTimes(1);
  expect(other).toHaveBeenCalledTimes(3);
  const failure = new Error('remote unavailable');
  reject(failure);
  await vi.advanceTimersByTimeAsync(0);
  expect(errors).toHaveBeenCalledWith(failure, 'first');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(first).toHaveBeenCalledTimes(2);
  coordinator.stop('first');
  coordinator.stop('other');
});

it('does not start stopped or superseded scheduled work', async () => {
  vi.useFakeTimers();
  const coordinator = createPollingCoordinator(vi.fn());
  const stopped = vi.fn(async () => {});
  const superseded = vi.fn(async () => {});
  const current = vi.fn(async () => {});
  coordinator.start('stopped', 5_000, stopped);
  coordinator.stop('stopped');
  coordinator.start('replaced', 5_000, superseded);
  coordinator.start('replaced', 5_000, current);
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).not.toHaveBeenCalled();
  expect(superseded).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledTimes(1);
  coordinator.stop('replaced');
});
