import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@autopod/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEvents,
  createAgentExecutionFixture,
  syntheticComplete,
} from '../test-utils/agent-execution-helpers.js';
import { createAgentEventConsumption } from './agent-event-consumption.js';

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
  it('rechecks a report arriving during persisted cooldown before starting another worker', async () => {
    const f = fixture();
    f.running();
    vi.useFakeTimers({ now: Date.now() });
    const delay = vi.fn(async (milliseconds: number) => {
      vi.setSystemTime(Date.now() + milliseconds);
      f.deps.escalationRepo.insert({
        id: 'cooldown-infra',
        podId: 'prepare',
        type: 'report_blocker',
        timestamp: new Date().toISOString(),
        response: null,
        payload: {
          kind: 'infrastructure',
          requiresResponse: false,
          lifecycleGeneration: f.pod().lifecycleGeneration,
          description: 'Runner unavailable',
          attempted: [],
          needs: 'Qualified execution',
        },
      });
    });
    const consumer = createAgentEventConsumption(
      {
        ...f.deps,
        workerInfrastructureRetryBackoffMs: [1000],
        workerInfrastructureRetryDelay: delay,
      },
      f.consumerCaptured,
    );
    await consumer.consumeAgentEvents(
      'prepare',
      agentEvents({
        type: 'error',
        timestamp: syntheticComplete.timestamp,
        message: 'Transient provider failure',
        fatal: true,
        classification: {
          category: 'transient',
          definitive: false,
          sanitizedMessage: 'Transient provider failure',
        },
      }),
    );
    f.running();
    const executed = f.podRepo.workerRetries?.state('prepare').executedCount;
    let pulled = false;
    await expect(
      consumer.consumeAgentEvents(
        'prepare',
        (async function* () {
          pulled = true;
          yield syntheticComplete;
        })(),
      ),
    ).rejects.toMatchObject({ code: 'INFRASTRUCTURE_BLOCKED' });
    expect(delay).toHaveBeenCalledOnce();
    expect(pulled).toBe(false);
    expect(f.podRepo.workerRetries?.state('prepare').executedCount).toBe(executed);
    expect(f.consumerCaptured.reconcileInfrastructureBlocker).toHaveBeenCalledExactlyOnceWith(
      'prepare',
    );
  });
  it('does not start a worker when infrastructure is reported during baseline capture', async () => {
    const f = fixture();
    f.running();
    let resolve!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    vi.mocked(f.cm.execInContainer).mockImplementationOnce(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let pulled = false;
    const consuming = f.consumer.consumeAgentEvents(
      'prepare',
      (async function* () {
        pulled = true;
        yield syntheticComplete;
      })(),
    );
    // A below-threshold report is durable without changing lifecycle or pause intent.
    f.deps.escalationRepo.insert({
      id: 'baseline-infra',
      podId: 'prepare',
      type: 'report_blocker',
      timestamp: new Date().toISOString(),
      response: null,
      payload: {
        kind: 'infrastructure',
        requiresResponse: false,
        lifecycleGeneration: f.pod().lifecycleGeneration,
        description: 'Runner unavailable',
        attempted: [],
        needs: 'Qualified execution',
      },
    });
    expect(f.pod().status).toBe('running');
    expect(f.consumerCaptured.pauseIntents.has('prepare')).toBe(false);
    const rejected = expect(consuming).rejects.toMatchObject({ code: 'INFRASTRUCTURE_BLOCKED' });
    resolve({
      stdout: JSON.stringify({ version: 1, complete: true, files: [] }),
      stderr: '',
      exitCode: 0,
    });
    await rejected;
    expect(pulled).toBe(false);
    expect(f.deps.eventRepo.getForSession('prepare', { type: 'pod.agent_activity' })).toEqual([]);
    expect(f.consumerCaptured.reconcileInfrastructureBlocker).toHaveBeenCalledExactlyOnceWith(
      'prepare',
    );
    expect(f.registry.activeAgentRuns.size).toBe(0);
  });

  it.each([
    'claude',
    'codex',
    'pi',
    'copilot',
  ] as const)('publishes one observed File event for %s shell edits before completion, preserving tool events', async (runtime) => {
    const f = fixture();
    f.running();
    f.podRepo.update('prepare', { runtime });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.directory });
    git('init', '-q');
    git('config', 'user.name', 'Observer Test');
    git('config', 'user.email', 'observer@example.invalid');
    git('config', 'core.hooksPath', '/dev/null');
    writeFileSync(join(f.directory, '.gitignore'), '*\n');
    writeFileSync(join(f.directory, 'source.ts'), 'initial');
    git('add', '-f', 'source.ts', '.gitignore');
    git('commit', '-qm', 'initial');
    vi.mocked(f.cm.execInContainer).mockImplementation(async (_id, command, options) => {
      options?.assertCurrent?.();
      return {
        stdout: execFileSync(process.execPath, command.slice(1), {
          cwd: f.directory,
          encoding: 'utf8',
        }),
        stderr: '',
        exitCode: 0,
      };
    });
    const live: AgentEvent[] = [];
    f.deps.eventBus.subscribe((event) => {
      if (event.type === 'pod.agent_activity') live.push(event.event);
    });
    // This test varies event runtime only; provider eligibility is covered
    // by provider-attempt tests rather than synthetic cross-provider accounts.
    const consumer = createAgentEventConsumption(
      { ...f.deps, providerAttemptRepo: undefined },
      {
        ...f.consumerCaptured,
        resolveEffectiveBoundProfile: () => f.profiles.get('test-profile'),
        ensureProviderAttempt: () => null,
        closeProviderAttempt: vi.fn(),
      },
    );
    const stream = (async function* () {
      // The baseline must exist before the first iterator pull edits anything.
      execFileSync('/bin/sh', ['-c', 'printf edited > source.ts'], { cwd: f.directory });
      yield {
        type: 'tool_use',
        timestamp: syntheticComplete.timestamp,
        tool: 'Bash',
        input: { command: 'edit via shell' },
      } as const;
      // A duplicate native patch report and even a failed/no-op phantom must
      // not produce additional File rows when observation is authoritative.
      yield {
        type: 'file_change',
        timestamp: syntheticComplete.timestamp,
        path: '/workspace/source.ts',
        action: 'modify',
      } as const;
      yield {
        type: 'file_change',
        timestamp: syntheticComplete.timestamp,
        path: 'phantom.ts',
        action: 'create',
      } as const;
      git('add', 'source.ts');
      git('commit', '-qm', 'agent edit');
      yield syntheticComplete;
    })();
    expect(await consumer.consumeAgentEvents('prepare', stream)).toBe('completed');
    expect(live.map((event) => event.type)).toEqual(['tool_use', 'file_change', 'complete']);
    expect(live[1]).toMatchObject({ path: 'source.ts', action: 'modify', source: 'workspace' });
    const stored = f.deps.eventRepo.getForSession('prepare', { type: 'pod.agent_activity' });
    expect(stored.map((entry) => entry.payload)).toMatchObject(
      live.map((event) => ({ type: 'pod.agent_activity', podId: 'prepare', event })),
    );
  });

  it.each([
    'pause',
    'replacement',
  ] as const)('does not start the worker or publish file events after %s during baseline capture', async (change) => {
    const f = fixture();
    f.running();
    let resolve!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    vi.mocked(f.cm.execInContainer).mockImplementationOnce(
      async () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    let pulled = false;
    const consuming = f.consumer.consumeAgentEvents(
      'prepare',
      (async function* () {
        pulled = true;
        yield syntheticComplete;
      })(),
    );
    if (change === 'pause') f.consumerCaptured.pauseIntents.set('prepare', Symbol('pause'));
    else f.podRepo.incrementLifecycleGeneration('prepare');
    resolve({
      stdout: JSON.stringify({ version: 1, complete: true, files: [] }),
      stderr: '',
      exitCode: 0,
    });
    expect(await consuming).toBe(change === 'pause' ? 'paused' : 'stopped');
    expect(pulled).toBe(false);
    expect(f.deps.eventRepo.getForSession('prepare', { type: 'pod.agent_activity' })).toEqual([]);
  });

  it.each([
    'pause',
    'replacement',
  ] as const)('drops a final snapshot and completion after %s while terminal observation is in flight', async (change) => {
    const f = fixture();
    f.running();
    let finishStarted!: () => void;
    const started = new Promise<void>((done) => {
      finishStarted = done;
    });
    let resolve!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
    vi.mocked(f.cm.execInContainer)
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ version: 1, complete: true, files: [] }),
        stderr: '',
        exitCode: 0,
      })
      .mockImplementationOnce(async () => {
        finishStarted();
        return new Promise((done) => {
          resolve = done;
        });
      });
    const consuming = f.consumer.consumeAgentEvents('prepare', agentEvents(syntheticComplete));
    await started;
    if (change === 'pause') f.consumerCaptured.pauseIntents.set('prepare', Symbol('pause'));
    else f.podRepo.incrementLifecycleGeneration('prepare');
    resolve({
      stdout: JSON.stringify({
        version: 1,
        complete: true,
        files: [['late.ts', `100644:${'a'.repeat(40)}`]],
      }),
      stderr: '',
      exitCode: 0,
    });
    expect(await consuming).toBe(change === 'pause' ? 'paused' : 'stopped');
    expect(f.deps.eventRepo.getForSession('prepare', { type: 'pod.agent_activity' })).toEqual([]);
    expect(f.pod().inputTokens).toBe(0);
  });

  it.each([
    'paused',
    'superseded',
  ] as const)('retains bound unverified termination before suppressing %s events', async (mode) => {
    const f = fixture(true);
    f.running();
    const stream = (async function* () {
      if (mode === 'paused') f.consumerCaptured.pauseIntents.set('prepare', Symbol('pause'));
      else f.podRepo.incrementLifecycleGeneration('prepare');
      yield {
        type: 'error' as const,
        timestamp: syntheticComplete.timestamp,
        message: 'Native termination not confirmed',
        fatal: true,
        executionTermination: 'unverified' as const,
      };
    })();
    expect(await f.consumer.consumeAgentEvents('prepare', stream)).toBe(
      mode === 'paused' ? 'paused' : 'stopped',
    );
    expect(f.podRepo.taskExecutions?.hasUnverifiedTermination('prepare')).toBe(true);
    expect(f.podRepo.taskExecutions?.hasActiveRun('prepare')).toBe(true);
    expect(f.pod().status).toBe('running');
    expect(f.registry.activeAgentRuns.size).toBe(0);
    const reopened = f.reopen();
    expect(reopened.pods.taskExecutions?.hasUnverifiedTermination('prepare')).toBe(true);
    expect(reopened.pods.taskExecutions?.hasActiveRun('prepare')).toBe(true);
  });
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
