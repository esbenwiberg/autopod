import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEvents,
  createAgentExecutionFixture,
  syntheticComplete,
} from '../test-utils/agent-execution-helpers.js';
const fixtures: ReturnType<typeof createAgentExecutionFixture>[] = [];
function fixture(disk = false) {
  const f = createAgentExecutionFixture(disk);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of fixtures.splice(0).reverse()) f.close();
});

describe('agent event consumption owner', () => {
  it('records a repeated completion once and settles every shared run owner', async () => {
    const f = fixture();
    f.running();
    expect(
      await f.consumer.consumeAgentEvents(
        'prepare',
        agentEvents(syntheticComplete, syntheticComplete),
      ),
    ).toBe('completed');
    expect(f.pod()).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      costUsd: 0.01,
      phaseTokenUsage: { agent_initial: { inputTokens: 2, outputTokens: 3, costUsd: 0.01 } },
    });
    expect(f.repo.list('prepare')).toMatchObject([
      { outcome: 'completed', inputTokens: 2, outputTokens: 3 },
    ]);
    expect(f.registry.activeAgentRuns.size).toBe(0);
    expect(f.registry.activeAgentRunResolvers.size).toBe(0);
    expect(f.activity.lastEventWriteAt.size).toBe(0);
    expect(f.consumerCaptured.startCommitPolling).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(f.consumerCaptured.stopCommitPolling).toHaveBeenCalledExactlyOnceWith('prepare');
    expect(f.podRepo.taskExecutions?.snapshot('prepare').agentRunCount).toBe(1);
  });
  it('rejects a superseded lifecycle before pulling the iterator or admitting a run', async () => {
    const f = fixture();
    f.running();
    const old = f.pod();
    f.podRepo.incrementLifecycleGeneration('prepare');
    let consumed = false;
    expect(
      await f.consumer.consumeAgentEvents(
        'prepare',
        (async function* () {
          consumed = true;
          yield syntheticComplete;
        })(),
        0,
        { generation: old.lifecycleGeneration, containerId: old.containerId },
      ),
    ).toBe('stopped');
    expect(consumed).toBe(false);
    expect(f.podRepo.taskExecutions?.snapshot('prepare').agentRunCount).toBe(0);
    expect(f.consumerCaptured.startCommitPolling).not.toHaveBeenCalled();
  });
  it('rethrows the original stream error after durable failure settlement and cleanup', async () => {
    const f = fixture();
    f.running();
    const failure = new Error('Synthetic stream transport failure');
    await expect(
      f.consumer.consumeAgentEvents(
        'prepare',
        (async function* () {
          yield await Promise.reject(failure);
        })(),
      ),
    ).rejects.toBe(failure);
    expect(f.repo.list('prepare').at(-1)?.outcome).toBe('failed');
    expect(f.podRepo.taskExecutions?.hasActiveRun('prepare')).toBe(false);
    expect(f.registry.activeAgentRuns.size).toBe(0);
    expect(f.registry.activeAgentRunResolvers.size).toBe(0);
    expect(f.consumerCaptured.stopCommitPolling).toHaveBeenCalledOnce();
  });
  it('honors pause intent without publishing the blocked event and releases its run', async () => {
    const f = fixture();
    f.running();
    f.consumerCaptured.pauseIntents.set('prepare', Symbol('pause'));
    expect(await f.consumer.consumeAgentEvents('prepare', agentEvents(syntheticComplete))).toBe(
      'paused',
    );
    expect(f.pod().inputTokens).toBe(0);
    expect(f.repo.list('prepare').at(-1)?.outcome).toBe('aborted');
    expect(f.registry.activeAgentRuns.size).toBe(0);
    expect(f.podRepo.taskExecutions?.hasActiveRun('prepare')).toBe(false);
  });
  it('settles its own promise while retaining replacement maps, polling and liveness', async () => {
    const f = fixture();
    f.running();
    const token = Symbol('replacement');
    const resolve = vi.fn();
    let settled: Promise<void> | undefined;
    const replacement = { token, settled: Promise.resolve(), isCurrent: () => true };
    const stream = (async function* () {
      settled = f.registry.activeAgentRuns.get('prepare')?.settled;
      f.registry.activeAgentRuns.set('prepare', replacement);
      f.registry.activeAgentRunResolvers.set('prepare', { token, resolve });
      f.activity.lastEventWriteAt.set('prepare', 1);
      yield syntheticComplete;
    })();
    expect(await f.consumer.consumeAgentEvents('prepare', stream)).toBe('stopped');
    await expect(settled).resolves.toBeUndefined();
    expect(f.registry.activeAgentRuns.get('prepare')).toBe(replacement);
    expect(f.registry.activeAgentRunResolvers.get('prepare')?.resolve).toBe(resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(f.activity.lastEventWriteAt.get('prepare')).toBe(1);
    expect(f.consumerCaptured.stopCommitPolling).not.toHaveBeenCalled();
    expect(f.pod().inputTokens).toBe(0);
  });
  it('preserves terminal usage/provider/task history through private SQLite close and reopen', async () => {
    const f = fixture(true);
    f.running();
    await f.consumer.consumeAgentEvents('prepare', agentEvents(syntheticComplete));
    const pod = f.pod();
    const task = f.podRepo.taskExecutions?.snapshot('prepare');
    const before = f.db.prepare('SELECT * FROM provider_attempts WHERE pod_id = ?').all('prepare');
    const unrelated = f.profiles.get('test-profile');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('prepare')).toEqual(pod);
    expect(next.pods.taskExecutions?.snapshot('prepare')).toEqual(task);
    expect(f.db.prepare('SELECT * FROM provider_attempts WHERE pod_id = ?').all('prepare')).toEqual(
      before,
    );
    expect(next.profiles.get('test-profile')).toEqual(unrelated);
  });
  it('retains unverified task admission through actual SQLite reopen without leaking in-memory ownership', async () => {
    const f = fixture(true);
    f.running();
    expect(
      await f.consumer.consumeAgentEvents(
        'prepare',
        agentEvents({
          type: 'error',
          timestamp: syntheticComplete.timestamp,
          message: 'Synthetic unverified exit',
          fatal: true,
          executionTermination: 'unverified',
        }),
      ),
    ).toBe('failed');
    expect(f.podRepo.taskExecutions?.hasActiveRun('prepare')).toBe(true);
    expect(f.registry.activeAgentRuns.size).toBe(0);
    expect(f.registry.activeAgentRunResolvers.size).toBe(0);
    const task = f.podRepo.taskExecutions?.snapshot('prepare');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.taskExecutions?.hasActiveRun('prepare')).toBe(true);
    expect(next.pods.taskExecutions?.snapshot('prepare')).toEqual(task);
  });
});
