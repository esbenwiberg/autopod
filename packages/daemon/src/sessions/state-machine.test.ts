import { InvalidStateTransitionError } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import {
  canKill,
  canReceiveMessage,
  isTerminalState,
  validateTransition,
} from './state-machine.js';

describe('state-machine', () => {
  describe('validateTransition', () => {
    it('allows valid transitions', () => {
      expect(() => validateTransition('s1', 'queued', 'provisioning')).not.toThrow();
      expect(() => validateTransition('s1', 'provisioning', 'running')).not.toThrow();
      expect(() => validateTransition('s1', 'running', 'awaiting_input')).not.toThrow();
      expect(() => validateTransition('s1', 'running', 'validating')).not.toThrow();
      expect(() => validateTransition('s1', 'validating', 'validated')).not.toThrow();
      expect(() => validateTransition('s1', 'validated', 'approved')).not.toThrow();
      expect(() => validateTransition('s1', 'approved', 'merging')).not.toThrow();
      expect(() => validateTransition('s1', 'merging', 'complete')).not.toThrow();
      expect(() => validateTransition('s1', 'killing', 'killed')).not.toThrow();
    });

    it('allows killing from killable states', () => {
      expect(() => validateTransition('s1', 'queued', 'killing')).not.toThrow();
      expect(() => validateTransition('s1', 'provisioning', 'killing')).not.toThrow();
      expect(() => validateTransition('s1', 'running', 'killing')).not.toThrow();
      expect(() => validateTransition('s1', 'awaiting_input', 'killing')).not.toThrow();
      expect(() => validateTransition('s1', 'failed', 'killing')).not.toThrow();
    });

    it('allows re-validation from failed state', () => {
      expect(() => validateTransition('s1', 'failed', 'validating')).not.toThrow();
    });

    it('allows re-validation from killed state', () => {
      expect(() => validateTransition('s1', 'killed', 'validating')).not.toThrow();
    });

    it('throws InvalidStateTransitionError for invalid transitions', () => {
      expect(() => validateTransition('s1', 'queued', 'running')).toThrow(
        InvalidStateTransitionError,
      );
      expect(() => validateTransition('s1', 'complete', 'running')).toThrow(
        InvalidStateTransitionError,
      );
      expect(() => validateTransition('s1', 'killed', 'running')).toThrow(
        InvalidStateTransitionError,
      );
      expect(() => validateTransition('s1', 'approved', 'killing')).toThrow(
        InvalidStateTransitionError,
      );
    });

    it('includes session id in error', () => {
      try {
        validateTransition('test-id', 'complete', 'running');
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).toContain('test-id');
      }
    });
  });

  describe('isTerminalState', () => {
    it('returns true for terminal states', () => {
      expect(isTerminalState('complete')).toBe(true);
      expect(isTerminalState('killed')).toBe(true);
    });

    it('returns false for non-terminal states', () => {
      expect(isTerminalState('queued')).toBe(false);
      expect(isTerminalState('running')).toBe(false);
      expect(isTerminalState('provisioning')).toBe(false);
      expect(isTerminalState('awaiting_input')).toBe(false);
      expect(isTerminalState('validating')).toBe(false);
      expect(isTerminalState('validated')).toBe(false);
      expect(isTerminalState('failed')).toBe(false);
      expect(isTerminalState('approved')).toBe(false);
      expect(isTerminalState('merging')).toBe(false);
      expect(isTerminalState('killing')).toBe(false);
    });
  });

  describe('canReceiveMessage', () => {
    it('returns true only for awaiting_input', () => {
      expect(canReceiveMessage('awaiting_input')).toBe(true);
    });

    it('returns false for all other states', () => {
      expect(canReceiveMessage('queued')).toBe(false);
      expect(canReceiveMessage('running')).toBe(false);
      expect(canReceiveMessage('provisioning')).toBe(false);
      expect(canReceiveMessage('validating')).toBe(false);
      expect(canReceiveMessage('validated')).toBe(false);
      expect(canReceiveMessage('failed')).toBe(false);
      expect(canReceiveMessage('complete')).toBe(false);
      expect(canReceiveMessage('killed')).toBe(false);
    });
  });

  describe('canKill', () => {
    it('returns true for killable states', () => {
      expect(canKill('queued')).toBe(true);
      expect(canKill('provisioning')).toBe(true);
      expect(canKill('running')).toBe(true);
      expect(canKill('awaiting_input')).toBe(true);
      expect(canKill('failed')).toBe(true);
    });

    it('returns false for non-killable states', () => {
      expect(canKill('approved')).toBe(false);
      expect(canKill('merging')).toBe(false);
      expect(canKill('complete')).toBe(false);
      expect(canKill('killed')).toBe(false);
      expect(canKill('killing')).toBe(false);
    });
  });
});
