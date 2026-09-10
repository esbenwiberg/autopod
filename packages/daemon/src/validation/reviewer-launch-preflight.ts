import type {
  BeforeReviewerLaunch,
  ReviewerLaunchIdentity,
} from '../interfaces/reviewer-launch.js';

export class ReviewerLaunchTimeoutError extends Error {
  constructor() {
    super('Reviewer preflight timed out before CLI launch');
  }
}

/** A late probe may settle, but cannot revive an expired reviewer launch. */
export async function prepareReviewerLaunch(
  beforeLaunch: BeforeReviewerLaunch | undefined,
  identity: ReviewerLaunchIdentity,
  timeout: number,
): Promise<{ timeout: number; assertCurrent?: () => void; remainingTimeout?: () => number }> {
  if (!beforeLaunch) return { timeout };
  if (!Number.isFinite(timeout) || timeout <= 0) throw new ReviewerLaunchTimeoutError();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const assertOwner = await Promise.race([
      beforeLaunch(identity),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new ReviewerLaunchTimeoutError());
        }, timeout);
      }),
    ]);
    const remainingTimeout = () => Math.max(0, Math.floor(timeout - (performance.now() - started)));
    const remaining = remainingTimeout();
    if (expired || remaining <= 0) throw new ReviewerLaunchTimeoutError();
    return {
      timeout: remaining,
      remainingTimeout,
      assertCurrent() {
        if (remainingTimeout() <= 0) throw new ReviewerLaunchTimeoutError();
        assertOwner();
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
