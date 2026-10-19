import { describe, expect, it, vi } from 'vitest';
import { deferred } from '../test-utils/resource-helpers.js';
import { createValidationTriggerCalls } from './pod-facade-calls.js';
import type { ValidationWorkflowCalls } from './validation-workflow-ports.js';
function receiver(): ValidationWorkflowCalls {
  return {
    triggerValidation: vi.fn(async () => {}),
    assertCanRework: vi.fn(),
    approveSession: vi.fn(async () => {}),
    consumeAgentEvents: vi.fn<ValidationWorkflowCalls['consumeAgentEvents']>(
      async () => 'completed',
    ),
    handleCompletion: vi.fn(async () => {}),
  };
}
describe('lazy validation facade call adapter', () => {
  it('constructs without invoking the receiver and retains exactly the original five capabilities', () => {
    const target = receiver();
    const calls = createValidationTriggerCalls(target);
    expect(Object.keys(calls)).toEqual([
      'triggerValidation',
      'assertCanRework',
      'approveSession',
      'consumeAgentEvents',
      'handleCompletion',
    ]);
    for (const fn of Object.values(target)) expect(fn).not.toHaveBeenCalled();
  });
  it('resolves every current property at invocation with original receiver, arguments and promises', async () => {
    const target = receiver();
    const calls = createValidationTriggerCalls(target);
    const gate = deferred();
    const trigger = vi.fn<ValidationWorkflowCalls['triggerValidation']>(function (
      this: unknown,
      id,
      options,
    ) {
      expect(this).toBe(target);
      expect(id).toBe('pod');
      expect(options).toEqual({ force: true });
      return gate.promise;
    });
    const assert = vi.fn<ValidationWorkflowCalls['assertCanRework']>(function (this: unknown, id) {
      expect(this).toBe(target);
      expect(id).toBe('pod');
    });
    const approve = vi.fn<ValidationWorkflowCalls['approveSession']>(function (
      this: unknown,
      id,
      options,
    ) {
      expect(this).toBe(target);
      expect(id).toBe('pod');
      expect(options).toEqual({ squash: true });
      return gate.promise;
    });
    const stream = (async function* () {})();
    const consume = vi.fn<ValidationWorkflowCalls['consumeAgentEvents']>(function (
      this: unknown,
      id,
      events,
      attempt,
    ) {
      expect(this).toBe(target);
      expect([id, events, attempt]).toEqual(['pod', stream, 4]);
      return Promise.resolve('completed');
    });
    const complete = vi.fn<ValidationWorkflowCalls['handleCompletion']>(function (
      this: unknown,
      id,
    ) {
      expect(this).toBe(target);
      expect(id).toBe('pod');
      return gate.promise;
    });
    Object.assign(target, {
      triggerValidation: trigger,
      assertCanRework: assert,
      approveSession: approve,
      consumeAgentEvents: consume,
      handleCompletion: complete,
    });
    expect(calls.triggerValidation('pod', { force: true })).toBe(gate.promise);
    calls.assertCanRework('pod');
    expect(calls.approveSession('pod', { squash: true })).toBe(gate.promise);
    await expect(calls.consumeAgentEvents('pod', stream, 4)).resolves.toBe('completed');
    expect(calls.handleCompletion('pod')).toBe(gate.promise);
    gate.resolve();
    await gate.promise;
    for (const fn of [trigger, assert, approve, consume, complete])
      expect(fn).toHaveBeenCalledOnce();
  });
  it('preserves synchronous throw and asynchronous rejection identity instead of wrapping either', async () => {
    const target = receiver();
    const calls = createValidationTriggerCalls(target);
    const error = new Error('Synthetic refusal');
    target.assertCanRework = () => {
      throw error;
    };
    expect(() => calls.assertCanRework('pod')).toThrow(error);
    const failed = Promise.reject(error);
    target.triggerValidation = () => failed;
    const observed = calls.triggerValidation('pod');
    expect(observed).toBe(failed);
    await expect(observed).rejects.toBe(error);
  });
});
