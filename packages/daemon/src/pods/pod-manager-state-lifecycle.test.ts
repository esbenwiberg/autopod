import type { ValidationResult } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../test-utils/mock-helpers.js';
import { deferred } from '../test-utils/resource-helpers.js';
import { createPodManager } from './pod-manager.js';
import { createValidationExecution } from './validation-execution.js';
import { ValidationSupersededError } from './validation-ownership.js';
import { createValidationWorkflowState } from './validation-workflow-state.js';

vi.mock('./validation-workflow-state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./validation-workflow-state.js')>();
  return {
    ...original,
    createValidationWorkflowState: vi.fn(original.createValidationWorkflowState),
  };
});
vi.mock('./validation-execution.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./validation-execution.js')>();
  return {
    ...original,
    createValidationExecution: vi.fn(
      (...args: Parameters<typeof original.createValidationExecution>) => {
        const execution = original.createValidationExecution(...args);
        return {
          ...execution,
          validateWithInfrastructureRetries: vi.fn(execution.validateWithInfrastructureRetries),
        };
      },
    ),
  };
});
const contexts: ReturnType<typeof createTestContext>[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.db.close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function instance(status: 'running' | 'failed' | 'review_required') {
  const context = createTestContext();
  contexts.push(context);
  vi.spyOn(context.deps.logger, 'warn');
  const manager = createPodManager(context.deps);
  const pod = manager.createSession(
    { profileName: 'test-profile', task: 'State lifetime' },
    'operator',
  );
  context.podRepo.update(pod.id, {
    status,
    containerId: 'container',
    worktreePath: '/tmp/controlled-lifecycle-worktree',
  });
  const state = vi.mocked(createValidationWorkflowState).mock.results.at(-1)?.value;
  const execution = vi.mocked(createValidationExecution).mock.results.at(-1)?.value;
  if (!state || !execution) throw new Error('Missing actual composed state boundary');
  return { context, manager, pod, state, execution };
}

describe('final composed validation state lifetime', () => {
  for (const entry of ['trigger', 'revalidate'] as const) {
    it.each(['success', 'superseded', 'replacement'] as const)(
      `${entry} releases only its own controller on %s settlement`,
      async (outcome) => {
        const f = instance(entry === 'trigger' ? 'running' : 'failed');
        const gate = deferred<ValidationResult>();
        vi.mocked(f.execution.validateWithInfrastructureRetries).mockReturnValueOnce(gate.promise);
        const pending =
          entry === 'trigger'
            ? f.manager.triggerValidation(f.pod.id)
            : f.manager.revalidateSession(f.pod.id, { force: true });
        await vi.waitFor(() =>
          expect(f.execution.validateWithInfrastructureRetries).toHaveBeenCalledOnce(),
        );
        const original = f.state.validationAbortControllers.get(f.pod.id);
        expect(original).toBeInstanceOf(AbortController);
        const replacement = new AbortController();
        if (outcome === 'replacement') {
          f.state.validationAbortControllers.set(f.pod.id, replacement);
        }
        if (outcome === 'superseded') gate.reject(new ValidationSupersededError());
        else {
          const config = vi.mocked(f.execution.validateWithInfrastructureRetries).mock
            .calls[0]?.[0];
          if (!config) throw new Error('Missing actual validation configuration');
          gate.resolve(await f.context.validationEngine.validate(config));
        }
        await pending;
        if (outcome === 'replacement') {
          expect(f.state.validationAbortControllers.get(f.pod.id)).toBe(replacement);
          expect(replacement.signal.aborted).toBe(false);
          expect(f.manager.getSession(f.pod.id).status).toBe('validating');
        } else {
          expect(f.state.validationAbortControllers.has(f.pod.id)).toBe(false);
          if (outcome === 'success')
            expect(f.manager.getSession(f.pod.id).status).toBe('validated');
        }
      },
    );
  }
  it('releases accepted attempt-extension state after its deferred recovery fails', async () => {
    const f = instance('review_required');
    const gate = deferred();
    const failure = new Error('Synthetic accepted recovery failure');
    f.manager.triggerValidation = vi.fn(() => gate.promise);
    await f.manager.extendAttempts(f.pod.id, 1);
    expect(f.state.attemptExtensionRuns.has(f.pod.id)).toBe(true);
    gate.reject(failure);
    await vi.waitFor(() => expect(f.state.attemptExtensionRuns.has(f.pod.id)).toBe(false));
    expect(f.manager.getSession(f.pod.id).maxValidationAttempts).toBe(4);
    expect(f.context.deps.logger.warn).toHaveBeenCalledWith(
      { err: failure, podId: f.pod.id },
      'Attempt-extension recovery failed after acceptance',
    );
  });
});
