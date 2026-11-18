import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFailingValidationResult, createTestContext } from '../test-utils/mock-helpers.js';
import { createPodManager } from './pod-manager.js';
import { createReworkRequestRepository } from './rework-request-repository.js';

describe('budget-stop manager lifecycle', () => {
  it('keeps the one-turn boundary through a completed continuation soft-budget pause and approval', async () => {
    // Start at an already-admitted continuation; this test targets completion
    // parking/approval, not permission to create that continuation.
    const ctx = createTestContext({
      validationResultFactory: ({ podId }) => createFailingValidationResult(podId),
    });
    try {
      ctx.db
        .prepare(
          "UPDATE profiles SET token_budget=100,token_budget_policy='soft',max_budget_extensions=NULL WHERE name='test-profile'",
        )
        .run();
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Finish saved work' },
        'operator',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'container-123',
        worktreePath: `/tmp/budget-complete-${pod.id}`,
        reworkReason: '[budget-continuation:coding]',
      });
      expect(
        await manager.consumeAgentEvents(
          pod.id,
          (async function* () {
            yield {
              type: 'complete' as const,
              timestamp: new Date().toISOString(),
              result: 'Coding finished',
              totalInputTokens: 101,
              totalOutputTokens: 1,
            };
          })(),
        ),
      ).toBe('paused');
      expect(manager.getSession(pod.id)).toMatchObject({
        status: 'paused',
        pauseReason: 'budget',
        reworkReason: '[budget-continuation:checks-only]',
      });
      ctx.podRepo.taskExecutions!.raiseBudget(pod.id, 200, 100, 'operator');
      await manager.approveBudgetPause(pod.id, { type: 'human', userId: 'operator' });
      expect(ctx.validationEngine.validate).toHaveBeenCalledOnce();
      expect(manager.getSession(pod.id).status).toBe('failed');
      expect(ctx.runtime.resume).not.toHaveBeenCalled();
      expect(ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(ctx.containerManager.kill).not.toHaveBeenCalled();
    } finally {
      ctx.db.close();
    }
  });
  it('retains native source/session and requires a new decision after the one continuation fails checks', async () => {
    const ctx = createTestContext({
      validationResultFactory: ({ podId }) => createFailingValidationResult(podId),
    });
    try {
      ctx.db
        .prepare(
          "UPDATE profiles SET token_budget=100,token_budget_policy='hard' WHERE name='test-profile'",
        )
        .run();
      ctx.runtime.suspendForUsage = vi.fn(async () => {});
      const manager = createPodManager(ctx.deps);
      const pod = manager.createSession(
        { profileName: 'test-profile', task: 'Finish saved work' },
        'operator',
      );
      ctx.podRepo.update(pod.id, {
        status: 'running',
        containerId: 'container-123',
        worktreePath: `/tmp/budget-stop-${pod.id}`,
        claudeSessionId: 'saved-native-session',
        validationAttempts: 1,
        lastValidationResult: createFailingValidationResult(pod.id),
        lastCorrectionMessage: 'Repair the previous test failure.',
      });
      await manager.consumeAgentEvents(
        pod.id,
        (async function* () {
          yield {
            type: 'usage' as const,
            timestamp: new Date().toISOString(),
            usageSegmentId: 'cap',
            sessionId: 'saved-native-session',
            usageSequence: 1,
            totalInputTokens: 101,
            totalOutputTokens: 1,
          };
        })(),
      );
      expect(manager.getSession(pod.id).finalization?.sourcePreservedAt).toBeTruthy();
      await expect(manager.resumePod(pod.id)).rejects.toMatchObject({
        code: 'BUDGET_CODING_CONTINUATION_REQUIRED',
      });
      await expect(manager.revalidateSession(pod.id, { force: true })).rejects.toMatchObject({
        code: 'BUDGET_CODING_CONTINUATION_REQUIRED',
      });
      await expect(manager.triggerValidation(pod.id)).rejects.toMatchObject({
        code: 'BUDGET_CODING_CONTINUATION_REQUIRED',
      });
      ctx.podRepo.taskExecutions!.raiseBudget(pod.id, null, 100, 'operator');
      ctx.podRepo.workerRetries!.authorize(
        pod.id,
        randomUUID(),
        'Reviewed cap stop; permit one coding continuation',
        { type: 'human', userId: 'operator' },
      );
      const requests = createReworkRequestRepository(ctx.db);
      const requestKey = randomUUID();
      requests.accept(
        pod.id,
        { requestKey, generation: pod.lifecycleGeneration, guidance: '' },
        { type: 'human', userId: 'operator' },
        () => manager.assertCanRework(pod.id),
      );
      vi.mocked(ctx.runtime.resume).mockImplementation(async function* () {
        yield {
          type: 'complete' as const,
          timestamp: new Date().toISOString(),
          result: 'Saved coding continuation completed',
          totalInputTokens: 3,
          totalOutputTokens: 2,
        };
      });
      await manager.triggerValidation(pod.id, {
        force: true,
        onReworkQueued: (generation, mode) =>
          requests.queueForGeneration(pod.id, requestKey, generation, mode),
      });
      expect(ctx.runtime.resume).toHaveBeenCalledOnce();
      expect(ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(ctx.containerManager.kill).not.toHaveBeenCalled();
      expect(ctx.containerManager.spawn).not.toHaveBeenCalled();
      expect(ctx.validationEngine.validate).toHaveBeenCalledOnce();
      expect(manager.getSession(pod.id)).toMatchObject({
        status: 'failed',
        containerId: 'container-123',
        validationAttempts: 2,
        reworkReason: '[budget-continuation:checks-only]',
      });
      expect(ctx.podRepo.taskExecutions!.snapshot(pod.id).recordedTotalTokens).toBe(107);
      expect(ctx.enqueuedSessions).toEqual([pod.id]); // Only the original creation admission.
    } finally {
      ctx.db.close();
    }
  });
});
