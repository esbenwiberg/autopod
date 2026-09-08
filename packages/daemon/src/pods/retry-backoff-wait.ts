import { TaskRetryBlockedError } from './task-retry-ledger.js';

/** Timers may wake early. The persisted deadline remains the authority. */
export async function waitForRetryBackoff(
  notBefore: string,
  delay: (milliseconds: number) => Promise<unknown>,
  assertCurrent: () => void,
): Promise<void> {
  const deadline = Date.parse(notBefore);
  if (!Number.isFinite(deadline))
    throw new TaskRetryBlockedError('Retry cooldown identity is unavailable');
  // Bound repeated early wakes or a regressing/stalled wall clock. Never turn
  // an unelapsed deadline into admission merely because a timer fulfilled.
  for (let wakes = 0; wakes <= 3; wakes++) {
    assertCurrent();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    if (wakes === 3 || remaining > 300_000)
      throw new TaskRetryBlockedError(
        'Persisted retry backoff has not elapsed; reconcile the clock before retrying',
        'TASK_RETRY_BACKOFF_PENDING',
      );
    await delay(remaining);
  }
}
