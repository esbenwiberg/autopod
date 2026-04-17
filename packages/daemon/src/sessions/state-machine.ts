import type { PodConfig, SessionStatus } from '@autopod/shared';
import { InvalidStateTransitionError, VALID_STATUS_TRANSITIONS } from '@autopod/shared';

export function validateTransition(
  sessionId: string,
  from: SessionStatus,
  to: SessionStatus,
): void {
  const valid = VALID_STATUS_TRANSITIONS[from];
  if (!valid.includes(to)) {
    throw new InvalidStateTransitionError(sessionId, from, to);
  }
}

export function isTerminalState(status: SessionStatus): boolean {
  return status === 'complete' || status === 'killed';
}

export function canReceiveMessage(status: SessionStatus): boolean {
  return status === 'awaiting_input' || status === 'paused';
}

export function canPause(status: SessionStatus): boolean {
  return status === 'running';
}

export function canNudge(status: SessionStatus): boolean {
  return status === 'running';
}

export function canKill(status: SessionStatus): boolean {
  return VALID_STATUS_TRANSITIONS[status].includes('killing');
}

/**
 * Can this session be promoted to a different pod config (e.g.
 * interactive→auto via `ap complete --pr`)? Only interactive sessions that
 * are currently running and haven't opted out via `promotable=false` are
 * eligible.
 */
export function canPromote(status: SessionStatus, pod: PodConfig): boolean {
  if (pod.agentMode !== 'interactive') return false;
  if (pod.promotable === false) return false;
  return status === 'running' || status === 'awaiting_input' || status === 'paused';
}
