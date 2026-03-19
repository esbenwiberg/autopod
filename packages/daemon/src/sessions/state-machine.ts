import type { SessionStatus } from '@autopod/shared';
import { VALID_STATUS_TRANSITIONS, InvalidStateTransitionError } from '@autopod/shared';

export function validateTransition(sessionId: string, from: SessionStatus, to: SessionStatus): void {
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
