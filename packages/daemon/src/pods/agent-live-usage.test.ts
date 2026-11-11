import type { AgentEvent, AgentUsageEvent } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentEvents, createAgentExecutionFixture } from '../test-utils/agent-execution-helpers.js';

const fixtures: ReturnType<typeof createAgentExecutionFixture>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = createAgentExecutionFixture();
  fixtures.push(f);
  f.running();
  const runtime = f.deps.runtimeRegistry.get('claude');
  runtime.suspendForUsage = vi.fn((id) => runtime.suspend(id));
  f.profiles.update('test-profile', { tokenBudgetPolicy: 'hard', maxBudgetExtensions: 0 });
  f.podRepo.update('prepare', { tokenBudget: 1000, claudeSessionId: 'native-session' });
  return f;
}
const checkpoint = (input = 40, output = 10, segment = 'segment-a'): AgentUsageEvent => ({
  type: 'usage',
  timestamp: '2026-11-11T17:00:00.000Z',
  usageSegmentId: segment,
  usageSequence: 1,
  sessionId: 'native-session',
  totalInputTokens: input,
  totalOutputTokens: output,
  cachedInputTokens: 20,
  costUsd: input / 10000,
});
const complete = (input = 100, output = 20, segment = 'segment-a'): AgentEvent => ({
  type: 'complete',
  timestamp: '2026-11-11T17:00:01.000Z',
  usageSegmentId: segment,
  totalInputTokens: input,
  totalOutputTokens: output,
  cachedInputTokens: 40,
  costUsd: input / 10000,
  result: 'Completed source work',
});

describe('live runtime accounting and hard-stop ownership', () => {
  it('persists a prefix before completion, without claiming final accounting, then adds only the terminal remainder', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents(
      'prepare',
      (async function* () {
        yield checkpoint();
        const pod = f.pod();
        expect(pod.inputTokens).toBe(40);
        expect(pod.outputTokens).toBe(10);
        expect(pod.tokenTelemetryAccuracy).toBe('partial');
        expect(pod.status).toBe('running');
        expect(f.podRepo.taskExecutions?.hasActiveRun('prepare')).toBe(true);
        expect(f.podRepo.taskExecutions?.snapshot('prepare').recordedTotalTokens).toBe(50);
        yield checkpoint(); // Duplicate channel/replay checkpoint must not double count.
        yield complete();
      })(),
    );
    expect(f.pod()).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
      tokenTelemetryAccuracy: 'complete',
    });
    expect(f.repo.list('prepare')).toMatchObject([
      { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
    ]);
    const events = f.deps.eventRepo.getForSession('prepare', { type: 'pod.agent_activity' });
    expect(JSON.stringify(events)).not.toContain('"type":"usage"');
  });

  it('retains measured spend when the worker aborts without a terminal usage event', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents(
      'prepare',
      agentEvents(checkpoint(), {
        type: 'error',
        timestamp: '2026-11-11T17:00:01.000Z',
        message: 'Provider failure',
        fatal: true,
      }),
    );
    expect(f.pod()).toMatchObject({
      inputTokens: 40,
      outputTokens: 10,
      tokenTelemetryAccuracy: 'partial',
    });
    expect(f.repo.list('prepare')).toMatchObject([{ inputTokens: 40, outputTokens: 10 }]);
    expect(f.podRepo.taskExecutions?.snapshot('prepare').budgetCheck?.status).toBe('unavailable');
  });

  it('stops the native process at the measured hard cap before accepting more worker events', async () => {
    const f = fixture();
    let continued = false;
    const outcome = await f.consumer.consumeAgentEvents(
      'prepare',
      (async function* () {
        yield checkpoint(1000, 1);
        continued = true;
        yield complete(2000, 20);
      })(),
    );
    expect(outcome).toBe('failed');
    expect(continued).toBe(false);
    expect(f.deps.runtimeRegistry.get('claude').suspend).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(f.pod()).toMatchObject({
      status: 'failed',
      inputTokens: 1000,
      outputTokens: 1,
      tokenTelemetryAccuracy: 'partial',
      failureReason: 'Token budget exceeded (1001/1000 tokens used).',
    });
    expect(f.podRepo.taskExecutions?.snapshot('prepare').budgetCheck?.status).toBe('exhausted');
    expect(f.podRepo.taskExecutions?.hasActiveRun('prepare')).toBe(false);
    expect(f.cm.kill).not.toHaveBeenCalled(); // Preserve the container/source, stop only the native worker.
  });

  it('retains an unresolved execution claim if the budget stop cannot prove termination', async () => {
    const f = fixture();
    vi.mocked(f.deps.runtimeRegistry.get('claude').suspend).mockRejectedValue(
      new Error('No stop proof'),
    );
    await expect(
      f.consumer.consumeAgentEvents('prepare', agentEvents(checkpoint(1000, 1))),
    ).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
    expect(f.podRepo.taskExecutions?.hasUnverifiedTermination('prepare')).toBe(true);
    expect(f.podRepo.taskExecutions?.hasActiveRun('prepare')).toBe(true);
    expect(f.podRepo.taskExecutions?.snapshot('prepare').recordedTotalTokens).toBe(1001);
  });

  it('does not stop a replacement owner when a usage transaction is superseded', async () => {
    const f = fixture();
    const { ProviderAttemptSupersededError } = await import('./provider-attempt-repository.js');
    vi.spyOn(f.repo, 'updateActive').mockImplementationOnce(() => {
      const owner = f.registry.activeAgentRuns.get('prepare');
      if (!owner) throw new Error('Expected old owner');
      f.registry.activeAgentRuns.set('prepare', { ...owner, token: Symbol('replacement') });
      throw new ProviderAttemptSupersededError();
    });
    expect(await f.consumer.consumeAgentEvents('prepare', agentEvents(checkpoint()))).toBe(
      'stopped',
    );
    expect(f.deps.runtimeRegistry.get('claude').suspendForUsage).not.toHaveBeenCalled();
  });

  it('treats an absent usage-stop capability as unverified, not a successful stop', async () => {
    const f = fixture();
    f.deps.runtimeRegistry.get('claude').suspendForUsage = undefined;
    await expect(
      f.consumer.consumeAgentEvents('prepare', agentEvents(checkpoint(1000, 1))),
    ).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
    expect(f.podRepo.taskExecutions?.hasUnverifiedTermination('prepare')).toBe(true);
  });

  it('downgrades finality on a later native accounting fault without erasing measured spend', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents(
      'prepare',
      agentEvents(checkpoint(), complete(), {
        type: 'error',
        timestamp: 'now',
        fatal: true,
        message: 'Native usage gap',
        usageIncomplete: true,
      }),
    );
    expect(f.pod()).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      tokenTelemetryAccuracy: 'partial',
    });
  });

  it('refuses a same-sequence checkpoint whose counters changed', async () => {
    const f = fixture();
    await expect(
      f.consumer.consumeAgentEvents('prepare', agentEvents(checkpoint(), checkpoint(41))),
    ).rejects.toMatchObject({ code: 'RUNTIME_USAGE_CONFLICT' });
    expect(f.pod().inputTokens).toBe(40);
    expect(f.deps.runtimeRegistry.get('claude').suspendForUsage).toHaveBeenCalledOnce();
  });

  it('keeps an extensible soft budget running until terminal accounting, then permits a normal budget extension', async () => {
    const f = fixture();
    f.profiles.update('test-profile', { tokenBudgetPolicy: 'soft', maxBudgetExtensions: 1 });
    const outcome = await f.consumer.consumeAgentEvents(
      'prepare',
      (async function* () {
        yield checkpoint(1000, 1);
        expect(f.pod().status).toBe('running');
        expect(f.pod().inputTokens).toBe(1000);
        expect(f.deps.runtimeRegistry.get('claude').suspendForUsage).not.toHaveBeenCalled();
        yield complete(1000, 20);
      })(),
    );
    expect(outcome).toBe('paused');
    expect(f.pod()).toMatchObject({
      status: 'paused',
      pauseReason: 'budget',
      inputTokens: 1000,
      outputTokens: 20,
      tokenTelemetryAccuracy: 'complete',
    });
    expect(f.deps.runtimeRegistry.get('claude').suspendForUsage).not.toHaveBeenCalled();
    f.podRepo.taskExecutions?.raiseBudget('prepare', 2000, 1000, 'operator');
    expect(f.podRepo.taskExecutions?.snapshot('prepare').budgetCheck?.status).toBe(
      'below_recorded_limit',
    );
  });

  it('refuses foreign session counters before they can alter spend', async () => {
    const f = fixture();
    await expect(
      f.consumer.consumeAgentEvents(
        'prepare',
        agentEvents({ ...checkpoint(), sessionId: 'foreign' }),
      ),
    ).rejects.toMatchObject({ code: 'RUNTIME_USAGE_CONFLICT' });
    expect(f.pod().inputTokens).toBe(0);
    expect(f.deps.runtimeRegistry.get('claude').suspend).toHaveBeenCalledExactlyOnceWith('prepare');
  });

  it('does not let a recovered invocation clear an earlier invocation with unknown final usage', async () => {
    const f = fixture();
    await f.consumer.consumeAgentEvents(
      'prepare',
      agentEvents(checkpoint(), checkpoint(20, 5, 'segment-b'), complete(100, 20, 'segment-b')),
    );
    expect(f.pod()).toMatchObject({
      inputTokens: 140,
      outputTokens: 30,
      tokenTelemetryAccuracy: 'partial',
    });
  });
});
