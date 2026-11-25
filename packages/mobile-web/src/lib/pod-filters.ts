import type { Pod, PodStatus } from '@autopod/shared';

const TERMINAL_STATUSES: ReadonlySet<PodStatus> = new Set(['complete', 'killed']);

const NEEDS_ME_STATUSES: ReadonlySet<PodStatus> = new Set([
  'research_ready',
  'awaiting_input',
  'review_required',
  'failed',
]);

type FleetOutcome = Pick<Pod, 'status' | 'failureClosedAt'>;

function isClosedFailure(pod: FleetOutcome): boolean {
  return pod.status === 'failed' && Boolean(pod.failureClosedAt);
}

export function isTerminal(pod: FleetOutcome): boolean {
  return TERMINAL_STATUSES.has(pod.status) || isClosedFailure(pod);
}

export function needsMe(pod: FleetOutcome): boolean {
  return NEEDS_ME_STATUSES.has(pod.status) && !isClosedFailure(pod);
}

export function isActive(pod: FleetOutcome): boolean {
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
