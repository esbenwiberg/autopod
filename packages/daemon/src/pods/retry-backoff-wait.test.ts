import { afterEach, expect, it, vi } from 'vitest';
import { waitForRetryBackoff } from './retry-backoff-wait.js';

afterEach(() => vi.useRealTimers());

it('bounds a clock that stops advancing without releasing the admission gate', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const delay = vi.fn(async () => undefined);
  const assertCurrent = vi.fn();
  await expect(
    waitForRetryBackoff(new Date(Date.now() + 50).toISOString(), delay, assertCurrent),
  ).rejects.toMatchObject({ code: 'TASK_RETRY_BACKOFF_PENDING' });
  expect(delay).toHaveBeenCalledTimes(3);
  expect(assertCurrent).toHaveBeenCalledTimes(4);
});

it('rechecks ownership after an early wake before waiting again', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const delay = vi.fn(async () => undefined);
  const assertCurrent = vi
    .fn()
    .mockImplementationOnce(() => undefined)
    .mockImplementation(() => {
      throw new Error('owner replaced');
    });
  await expect(
    waitForRetryBackoff(new Date(Date.now() + 50).toISOString(), delay, assertCurrent),
  ).rejects.toThrow('owner replaced');
  expect(delay).toHaveBeenCalledTimes(1);
});

it.each(['invalid', new Date(Date.now() + 900_000).toISOString()])(
  'refuses missing or excessive cooldown identity without a timer: %s',
  async (deadline) => {
    const delay = vi.fn(async () => undefined);
    await expect(waitForRetryBackoff(deadline, delay, () => undefined)).rejects.toThrow();
    expect(delay).not.toHaveBeenCalled();
  },
);
