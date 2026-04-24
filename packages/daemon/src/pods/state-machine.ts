import type { PodOptions, PodStatus } from '@autopod/shared';
import { InvalidStateTransitionError, VALID_STATUS_TRANSITIONS } from '@autopod/shared';

export function validateTransition(podId: string, from: PodStatus, to: PodStatus): void {
  const valid = VALID_STATUS_TRANSITIONS[from];
  if (!valid.includes(to)) {
    throw new InvalidStateTransitionError(podId, from, to);
  }
}

export function isTerminalState(status: PodStatus): boolean {
  return status === 'complete' || status === 'killed';
}

export function canReceiveMessage(status: PodStatus): boolean {
  return status === 'awaiting_input' || status === 'paused';
}

export function canPause(status: PodStatus): boolean {
  return status === 'running';
}

export function canNudge(status: PodStatus): boolean {
  return status === 'running';
}

export function canKill(status: PodStatus): boolean {
  return VALID_STATUS_TRANSITIONS[status].includes('killing');
}

export function canFail(status: PodStatus): boolean {
  return VALID_STATUS_TRANSITIONS[status].includes('failed');
}

/**
 * Can this pod be promoted to a different pod config (e.g.
 * interactive→auto via `ap complete --pr`)? Only interactive pods that
 * are currently running and haven't opted out via `promotable=false` are
 * eligible.
 */
export function canPromote(status: PodStatus, pod: PodOptions): boolean {
  if (pod.agentMode !== 'interactive') return false;
  if (pod.promotable === false) return false;
  return status === 'running' || status === 'awaiting_input' || status === 'paused';
}
