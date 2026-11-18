import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentEvents, createAgentExecutionFixture } from '../test-utils/agent-execution-helpers.js';
import {
  assertBudgetCodingNotInterrupted,
  assertBudgetStopContinuation,
  continueBudgetStoppedCoding,
  isBudgetStopped,
} from './budget-stop.js';
import { createReworkRequestRepository } from './rework-request-repository.js';
import {
  unavailableWorkerInputs,
  WORKER_RETRY_BACKOFFS_MS,
  workerBindingHash,
} from './worker-retry-history.js';

const fixtures: ReturnType<typeof createAgentExecutionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
const usage = {
  type: 'usage' as const,
  timestamp: '2026-11-18T00:00:00.000Z',
  usageSegmentId: 'before-cap',
  sessionId: 'saved-native-session',
  usageSequence: 1,
  totalInputTokens: 101,
  totalOutputTokens: 1,
};
function fixture() {
  const f = createAgentExecutionFixture();
  fixtures.push(f);
  f.running();
  f.profiles.update('test-profile', { tokenBudgetPolicy: 'hard', maxBudgetExtensions: 0 });
  f.podRepo.update('prepare', {
    tokenBudget: 100,
    worktreePath: '/tmp/preserved-budget-source',
    claudeSessionId: 'saved-native-session',
    validationAttempts: 1,
    lastCorrectionMessage: 'Repair the six failed tests, then finish the original task.',
  });
  const runtime = f.deps.runtimeRegistry.get('claude');
  runtime.suspendForUsage = vi.fn(async () => {});
  const calls = {
    assertCanRework: vi.fn(() => {
      const pod = f.pod();
      assertBudgetStopContinuation(f.podRepo, pod);
      return f.podRepo.workerRetries!.preview(
        pod.id,
        pod.lifecycleGeneration,
        unavailableWorkerInputs,
        workerBindingHash({
          runtime: pod.runtime,
          model: pod.model,
          providerAccountId: f.consumerCaptured.executionForPod(pod).providerAccountId ?? null,
        }),
        [...WORKER_RETRY_BACKOFFS_MS],
      );
    }),
    consumeAgentEvents: vi.fn(f.consumer.consumeAgentEvents),
    handleCompletion: vi.fn(async () => {}),
  };
  const journal = createReworkRequestRepository(f.db);
  const requestKey = randomUUID();
  const deps = {
    repo: f.podRepo,
    container: f.cm,
    transition: f.captured.transition,
    taskFeedbackEvents: vi.fn(async () =>
      agentEvents({
        type: 'complete' as const,
        timestamp: '2026-11-18T00:00:01.000Z',
        usageSegmentId: 'after-cap',
        totalInputTokens: 5,
        totalOutputTokens: 3,
        result: 'Finished retained work',
      }),
    ),
    persistRuntimeCredentialsForPod: vi.fn(async () => {}),
    emitActivityStatus: vi.fn(),
    onReworkQueued: (generation: number, mode?: 'retained-budget') =>
      journal.queueForGeneration('prepare', requestKey, generation, mode),
  };
  const human = { type: 'human' as const, userId: 'operator' };
  const authorize = () =>
    f.podRepo.workerRetries!.authorize(
      'prepare',
      randomUUID(),
      'Inspected cap stop; authorize one coding continuation',
      human,
    );
  const accept = () =>
    journal.accept(
      'prepare',
      {
        requestKey,
        generation: f.pod().lifecycleGeneration,
        guidance: 'Do not repeat completed edits.',
      },
      human,
      calls.assertCanRework,
    );
  return { ...f, runtime, calls, deps, journal, requestKey, authorize, accept };
}

describe('verified hard-budget stop and explicit coding continuation', () => {
  it('records failed worker settlement and preserves source without declaring completion or final usage', async () => {
    const f = fixture();
    expect(await f.consumer.consumeAgentEvents('prepare', agentEvents(usage))).toBe('failed');
    const pod = f.pod();
    expect(pod.finalization).toMatchObject({
      agentSettledAt: expect.any(String),
      sourcePreservedAt: expect.any(String),
      result: null,
    });
    expect(pod).toMatchObject({
      status: 'failed',
      pauseReason: 'budget',
      tokenTelemetryAccuracy: 'partial',
    });
    expect(
      f.podRepo.taskExecutions!.hasSettledRun!(pod, pod.finalization!.cycle, 'token_budget'),
    ).toBe(true);
    expect(f.consumerCaptured.preservePodWorkspace).toHaveBeenCalledOnce();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });

  it('saves unlimited separately, requires retry authorization, and resumes coding without deleting the original or resetting attempts', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    f.podRepo.taskExecutions!.raiseBudget('prepare', null, 100, 'operator');
    expect(() => f.accept()).toThrow(/Unchanged|nonretryable/);
    expect(f.deps.taskFeedbackEvents).not.toHaveBeenCalled();
    const grant = f.authorize();
    const original = f.pod();
    expect(f.accept().fresh).toBe(true);
    await continueBudgetStoppedCoding(original, f.calls, f.deps);
    expect(f.deps.taskFeedbackEvents).toHaveBeenCalledWith(
      'prepare',
      expect.stringContaining('Repair the six failed tests'),
      false,
    );
    expect(f.calls.consumeAgentEvents).toHaveBeenCalledOnce();
    expect(f.calls.handleCompletion).toHaveBeenCalledOnce();
    expect(f.pod()).toMatchObject({
      lifecycleGeneration: original.lifecycleGeneration,
      containerId: original.containerId,
      worktreePath: original.worktreePath,
      claudeSessionId: 'saved-native-session',
      validationAttempts: 1,
      tokenBudget: 100,
      reworkCount: original.reworkCount + 1,
    });
    expect(f.podRepo.taskExecutions!.snapshot('prepare').recordedTotalTokens).toBe(110);
    expect(f.podRepo.taskExecutions!.snapshot('prepare').tokenBudget).toBeNull();
    expect(
      f.podRepo.workerRetries!.state('prepare').authorizations.find((a) => a.id === grant.id)
        ?.usedByAttemptId,
    ).toBeTruthy();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(
      f.db.prepare('SELECT message FROM nudge_messages WHERE pod_id=?').all('prepare'),
    ).toEqual([{ message: expect.stringContaining('Do not repeat completed edits.') }]);
    expect(
      f.journal.accept(
        'prepare',
        {
          requestKey: f.requestKey,
          generation: original.lifecycleGeneration,
          guidance: 'Do not repeat completed edits.',
        },
        { type: 'human', userId: 'operator' },
        () => {
          throw new Error('Replay cannot readmit');
        },
      ).fresh,
    ).toBe(false);
  });

  it('retains the interrupted-coding guard if preparation fails before worker admission', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    f.podRepo.taskExecutions!.raiseBudget('prepare', null, 100, 'operator');
    f.authorize();
    f.accept();
    const original = f.pod();
    f.deps.taskFeedbackEvents.mockRejectedValueOnce(new Error('Preparation failed'));
    await expect(continueBudgetStoppedCoding(original, f.calls, f.deps)).rejects.toThrow(
      'Preparation failed',
    );
    expect(f.pod()).toMatchObject({ status: 'failed', pauseReason: 'budget' });
    expect(f.pod().failureReason).toContain('Token budget exceeded (');
    expect(f.calls.consumeAgentEvents).not.toHaveBeenCalled();
    expect(f.calls.handleCompletion).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    // No replacement lifecycle was invented: the original verified stop is
    // still usable by a new explicit request. The retry grant was not consumed.
    expect(() => assertBudgetStopContinuation(f.podRepo, f.pod())).not.toThrow();
    expect(f.pod().lifecycleGeneration).toBe(original.lifecycleGeneration);
    expect(f.podRepo.workerRetries!.state('prepare').authorizations[0]?.usedByAttemptId).toBeNull();
    f.journal.settle(f.requestKey, 'Preparation failed');
    const nextKey = randomUUID();
    f.journal.accept(
      'prepare',
      { requestKey: nextKey, generation: original.lifecycleGeneration, guidance: '' },
      { type: 'human', userId: 'operator' },
      f.calls.assertCanRework,
    );
    await continueBudgetStoppedCoding(f.pod(), f.calls, {
      ...f.deps,
      onReworkQueued: (generation, mode) =>
        f.journal.queueForGeneration('prepare', nextKey, generation, mode),
    });
    expect(f.calls.consumeAgentEvents).toHaveBeenCalledOnce();
    expect(f.calls.handleCompletion).toHaveBeenCalledOnce();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('allows checks, not another coding segment, when the cap first arrives on completed final usage', async () => {
    const f = fixture();
    const outcome = await f.consumer.consumeAgentEvents(
      'prepare',
      agentEvents({
        type: 'complete',
        timestamp: new Date().toISOString(),
        result: 'Coding finished',
        usageSegmentId: 'final-cap',
        totalInputTokens: 101,
        totalOutputTokens: 1,
      }),
    );
    expect(outcome).toBe('failed'); // No automatic spending beyond the cap.
    expect(f.pod().finalization?.result).toBe('Coding finished');
    expect(f.pod().pauseReason).toBeNull();
    expect(isBudgetStopped(f.pod())).toBe(false);
    expect(() => assertBudgetCodingNotInterrupted(f.pod())).not.toThrow();
    f.podRepo.taskExecutions!.raiseBudget('prepare', 200, 100, 'operator');
    expect(f.podRepo.taskExecutions!.snapshot('prepare').budgetCheck?.status).toBe(
      'below_recorded_limit',
    );
    expect(f.runtime.suspendForUsage).not.toHaveBeenCalled();
    expect(f.deps.taskFeedbackEvents).not.toHaveBeenCalled();
  });

  it('keeps an admitted worker failure separate from the preceding budget stop', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    f.podRepo.taskExecutions!.raiseBudget('prepare', null, 100, 'operator');
    f.authorize();
    f.accept();
    f.deps.taskFeedbackEvents.mockImplementationOnce(async () =>
      agentEvents({
        type: 'error',
        timestamp: new Date().toISOString(),
        message: 'Provider failed',
        fatal: true,
      }),
    );
    await continueBudgetStoppedCoding(f.pod(), f.calls, f.deps);
    expect(f.pod()).toMatchObject({
      status: 'failed',
      pauseReason: null,
      reworkReason: '[budget-continuation:coding]',
    });
    expect(isBudgetStopped(f.pod())).toBe(false);
    expect(f.pod().failureReason).not.toContain('Token budget exceeded');
    expect(f.calls.handleCompletion).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('cannot turn a larger finite cap into proof that incomplete prior spending is final', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    f.podRepo.taskExecutions!.raiseBudget('prepare', 200, 100, 'operator');
    expect(() => assertBudgetStopContinuation(f.podRepo, f.pod())).toThrow(
      /final usage|unknown spending/,
    );
    expect(f.deps.taskFeedbackEvents).not.toHaveBeenCalled();
  });

  it('does not invent preservation after a failed capture', async () => {
    const f = fixture();
    f.consumerCaptured.preservePodWorkspace.mockRejectedValue(new Error('Capture incomplete'));
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    expect(f.pod().finalization?.agentSettledAt).toBeTruthy();
    expect(f.pod().finalization?.sourcePreservedAt).toBeNull();
    expect(() => assertBudgetStopContinuation(f.podRepo, f.pod())).toThrow(/preservation/);
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('does not certify an unverified usage stop', async () => {
    const f = fixture();
    vi.mocked(f.runtime.suspendForUsage!).mockRejectedValue(new Error('Stop unknown'));
    await expect(
      f.consumer.consumeAgentEvents('prepare', agentEvents(usage)),
    ).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
    expect(f.pod().finalization?.agentSettledAt).toBeNull();
    expect(f.pod().finalization?.sourcePreservedAt).toBeNull();
    expect(f.consumerCaptured.preservePodWorkspace).not.toHaveBeenCalled();
    expect(f.podRepo.taskExecutions!.hasUnverifiedTermination('prepare')).toBe(true);
  });

  it('fences replacement lifecycle during preservation', async () => {
    const f = fixture();
    f.consumerCaptured.preservePodWorkspace.mockImplementation(async () => {
      f.podRepo.incrementLifecycleGeneration('prepare');
    });
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    expect(f.pod().finalization?.sourcePreservedAt).toBeFalsy();
  });

  it('refuses legacy missing stop proof even when the error text looks like a budget stop', () => {
    const f = fixture();
    f.podRepo.update('prepare', {
      status: 'failed',
      failureReason: 'Token budget exceeded (102/100 tokens used).',
    });
    expect(() => assertBudgetStopContinuation(f.podRepo, f.pod())).toThrow(
      /historical missing receipts/,
    );
    expect(f.deps.taskFeedbackEvents).not.toHaveBeenCalled();
  });

  it('rejects missing durable request before touching the resource', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    await expect(
      continueBudgetStoppedCoding(f.pod(), f.calls, { ...f.deps, onReworkQueued: undefined }),
    ).rejects.toMatchObject({ code: 'REWORK_REQUEST_REQUIRED' });
    expect(f.cm.start).not.toHaveBeenCalled();
  });

  it('cannot use the retained request mode after the recorded resource changes', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    f.podRepo.taskExecutions!.raiseBudget('prepare', null, 100, 'operator');
    f.authorize();
    f.accept();
    f.podRepo.update('prepare', { containerId: 'replacement-container' });
    expect(() =>
      f.journal.queueForGeneration(
        'prepare',
        f.requestKey,
        f.pod().lifecycleGeneration,
        'retained-budget',
      ),
    ).toThrow(/different request or lifecycle/);
    expect(
      f.db.prepare('SELECT message FROM nudge_messages WHERE pod_id=?').all('prepare'),
    ).toEqual([]);
  });

  it('fences resource replacement while checking readiness', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents('prepare', agentEvents(usage));
    f.podRepo.taskExecutions!.raiseBudget('prepare', null, 100, 'operator');
    f.authorize();
    f.accept();
    const original = f.pod();
    vi.mocked(f.cm.getStatus).mockImplementationOnce(async () => {
      f.podRepo.update('prepare', { containerId: 'replacement-container' });
      return 'running';
    });
    await expect(continueBudgetStoppedCoding(original, f.calls, f.deps)).rejects.toMatchObject({
      code: 'BUDGET_CONTINUATION_STALE',
    });
    expect(f.deps.taskFeedbackEvents).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });
});
