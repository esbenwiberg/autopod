import type { Pod, PodStatus } from '@autopod/shared';

const TERMINAL_STATUSES: ReadonlySet<PodStatus> = new Set(['complete', 'killed']);

const NEEDS_ME_STATUSES: ReadonlySet<PodStatus> = new Set([
  'awaiting_input',
  'review_required',
  'failed',
]);

export function isTerminal(pod: Pick<Pod, 'status'>): boolean {
  return TERMINAL_STATUSES.has(pod.status);
}

export function needsMe(pod: Pick<Pod, 'status'>): boolean {
  return NEEDS_ME_STATUSES.has(pod.status);
}

export function isActive(pod: Pick<Pod, 'status'>): boolean {
  return !isTerminal(pod);
}

/**
 * Recency-first ordering — the most-recently-updated pod floats to the top.
 * Falls back to creation time when `updatedAt` is missing on either side.
 */
export function byRecency<T extends { updatedAt?: string; createdAt?: string }>(
  a: T,
  b: T,
): number {
  const ka = a.updatedAt ?? a.createdAt ?? '';
  const kb = b.updatedAt ?? b.createdAt ?? '';
  return kb.localeCompare(ka);
}
