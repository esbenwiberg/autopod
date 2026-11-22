import type { RetainedCleanupBlocker } from '@autopod/shared';

export class CleanupBlocked extends Error {
  constructor(readonly blocker: RetainedCleanupBlocker) {
    super(blocker.message);
  }
}
export function block(
  code: RetainedCleanupBlocker['code'],
  message: string,
  resourceId?: string,
): never {
  throw new CleanupBlocked({ code, message, ...(resourceId ? { resourceId } : {}) });
}
export const diagnostic = (e: unknown, fallback: RetainedCleanupBlocker): RetainedCleanupBlocker =>
  e instanceof CleanupBlocked ? e.blocker : fallback;
