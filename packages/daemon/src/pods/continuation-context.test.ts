import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveLaunchConfig, McpServerConfig } from '@autopod/shared';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createProfileStore } from '../profiles/index.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createPassingValidationResult, createTestContext } from '../test-utils/mock-helpers.js';
import { createContinuationContext } from './continuation-context.js';
import type { ContinuationLiveDependencies } from './continuation-ports.js';
import { createGoalRepository } from './goal-repository.js';
import { createPodGoalService } from './pod-goal-service.js';
import { createPodRepository } from './pod-repository.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture() {
  const ctx = createTestContext();
  cleanups.push(() => ctx.db.close());
  ctx.podRepo.insert({
    id: 'context',
    profileName: 'test-profile',
    task: 'Original',
    status: 'running',
    runtime: 'claude',
    model: 'opus',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  ctx.podRepo.update('context', {
    containerId: 'container',
    worktreePath: '/tmp/continuation-fixture',
    claudeSessionId: 'old',
    codexSessionId: 'old-codex',
    piSessionId: 'old-pi',
  });
  const profiles = createProfileStore(ctx.db);
  const profile = profiles.get('test-profile');
  const order: string[] = [];
  const mcp: McpServerConfig[] = [{ type: 'http', name: 'escalation', url: 'http://fixture/mcp' }];
  const env = { FIXTURE: 'synthetic' };
  const live: ContinuationLiveDependencies = {};
  const captured = {
    podRepo: ctx.podRepo,
    nudgeRepo: ctx.nudgeRepo,
    containerManagerFactory: ctx.deps.containerManagerFactory,
    runtimeRegistry: ctx.runtimeRegistry,
    mcpBaseUrl: 'http://fixture',
    executionForPod: () => profile,
    resolveEffectiveBoundProfile: vi.fn(() => {
      order.push('binding');
      return profile;
    }),
    getResumeEnv: vi.fn(async () => {
      order.push('env');
      return env;
    }),
    primeRuntimeForResume: vi.fn(async () => {
      order.push('prime');
      return mcp;
    }),
    emitActivityStatus: vi.fn(),
  };
  const c = createContinuationContext(live, captured);
  return {
    ctx,
    c,
    live,
    captured,
    profile,
    order,
    mcp,
    env,
    pod: () => ctx.podRepo.getOrThrow('context'),
  };
}
describe('continuation context', () => {
  it('constructs inertly and appends journal and pending guidance to task wrappers', async () => {
    const f = fixture();
    expect(f.captured.getResumeEnv).not.toHaveBeenCalled();
    expect(f.captured.resolveEffectiveBoundProfile).not.toHaveBeenCalled();
    const journalOwner = f.ctx.podRepo.completionJournal;
    if (!journalOwner) throw new Error('Missing completion journal fixture');
    const journal = vi.spyOn(journalOwner, 'recoveryContext').mockReturnValue('\nJournal decision');
    vi.spyOn(f.ctx.nudgeRepo, 'hasPending').mockReturnValue(true);
    expect(f.c.appendDecisionContext(f.pod(), 'Task')).toContain(
      'Task\nJournal decision\n\nUncollected human guidance',
    );
    for (const text of [
      await f.c.buildRecoveryTask(f.pod(), '/missing-fixture'),
      await f.c.buildContinuationPrompt(f.pod(), '/missing-fixture'),
      await f.c.buildReworkTask(f.pod(), '/missing-fixture', 'Fix issue'),
    ]) {
      expect(text).toContain('Original');
      expect(text).toContain('Journal decision');
      expect(text).toContain('acknowledge_messages');
    }
    expect(journal).toHaveBeenCalledTimes(4);
  });
  it.each([false, true])(
    'primes provenance and the exact MCP array before fresh=%s task feedback',
    async (fresh) => {
      const f = fixture();
      const spawn = vi.spyOn(f.ctx.runtime, 'spawn');
      const resume = vi.spyOn(f.ctx.runtime, 'resume');
      const events = await f.c.taskFeedbackEvents('context', 'Reviewed changes', fresh);
      expect(events[Symbol.asyncIterator]).toBeTypeOf('function');
      expect(f.order).toEqual(['binding', 'binding', 'env', 'binding', 'binding', 'prime']);
      expect(f.ctx.podRepo.executionProvenance?.latest('context')?.status).toBe('checked');
      if (fresh) {
        expect(resume).not.toHaveBeenCalled();
        expect(spawn).toHaveBeenCalledOnce();
        const config = spawn.mock.calls[0]?.[0];
        expect(config).toMatchObject({
          task: 'Reviewed changes',
          model: 'opus',
          env: f.env,
          containerId: 'container',
          workDir: '/workspace',
        });
        expect(config?.mcpServers).toBe(f.mcp);
      } else {
        expect(spawn).not.toHaveBeenCalled();
        expect(resume).toHaveBeenCalledExactlyOnceWith(
          'context',
          'Reviewed changes',
          'container',
          f.env,
        );
      }
    },
  );
  it.each([false, true])(
    'wakes stopped feedback resources before credentials with fresh=%s',
    async (fresh) => {
      const f = fixture();
      let running = false;
      vi.mocked(f.ctx.containerManager.getStatus).mockImplementation(async () =>
        running ? 'running' : 'stopped',
      );
      vi.mocked(f.ctx.containerManager.start).mockImplementation(async () => {
        f.order.push('wake');
        running = true;
      });
      f.captured.getResumeEnv.mockImplementation(async () => {
        expect(running).toBe(true);
        f.order.push('env');
        return f.env;
      });
      await f.c.taskFeedbackEvents('context', 'Apply feedback', fresh);
      expect(f.order.indexOf('wake')).toBeLessThan(f.order.indexOf('env'));
      expect(f.ctx.containerManager.start).toHaveBeenCalledExactlyOnceWith('container', {
        assertCurrent: expect.any(Function),
      });
    },
  );
  it.each(['unknown', 'deleted'] as const)(
    'retains a feedback resource in state %s without waking, configuring or dispatching it',
    async (status) => {
      const f = fixture();
      vi.mocked(f.ctx.containerManager.getStatus).mockResolvedValue(status);
      await expect(
        f.c.taskFeedbackEvents('context', 'Apply feedback', false),
      ).rejects.toMatchObject({
        code: 'CONTINUATION_RESOURCE_UNAVAILABLE',
      });
      expect(f.ctx.containerManager.start).not.toHaveBeenCalled();
      expect(f.captured.getResumeEnv).not.toHaveBeenCalled();
      expect(f.captured.primeRuntimeForResume).not.toHaveBeenCalled();
      expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
      expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
      expect(f.pod().containerId).toBe('container');
    },
  );
  it('blocks an unverified original execution before observing or waking feedback resources', async () => {
    const f = fixture();
    const ledger = f.ctx.podRepo.taskExecutions;
    if (!ledger) throw new Error('Missing task ledger');
    const pod = f.pod();
    const run = ledger.beginRun('context', pod.lifecycleGeneration, 0, {
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: null,
      resource: { containerId: pod.containerId, executionTarget: pod.executionTarget },
    });
    ledger.retainUnverifiedRun(run);
    await expect(f.c.taskFeedbackEvents('context', 'Apply feedback', false)).rejects.toMatchObject({
      code: 'TASK_EXECUTION_TERMINATION_UNVERIFIED',
    });
    expect(f.ctx.containerManager.getStatus).not.toHaveBeenCalled();
    expect(f.ctx.containerManager.start).not.toHaveBeenCalled();
    expect(f.captured.getResumeEnv).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'never bypasses an unverified validation exit (fresh=%s)',
    async (fresh) => {
      const f = fixture();
      f.ctx.podRepo.update('context', {
        lastValidationResult: {
          ...createPassingValidationResult('context'),
          overall: 'fail',
          infrastructureFailure: {
            phase: 'build',
            code: 'EXEC_EXIT_UNVERIFIED',
            message: 'Original validation command exit is unverified',
            retryable: false,
          },
        },
      });
      await expect(
        f.c.taskFeedbackEvents('context', 'Apply feedback', fresh),
      ).rejects.toMatchObject({
        code: 'VALIDATION_EXECUTION_UNVERIFIED',
      });
      expect(f.ctx.containerManager.getStatus).not.toHaveBeenCalled();
      expect(f.captured.getResumeEnv).not.toHaveBeenCalled();
      expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
      expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    },
  );
  it.each(['observe', 'wake'] as const)('late %s failure keeps new work', async (phase) => {
    const f = fixture();
    const failLate = async () => {
      f.ctx.podRepo.incrementLifecycleGeneration('context');
      f.ctx.podRepo.update('context', { status: 'queued', containerId: 'replacement' });
      throw new Error('Old provider operation failed');
    };
    if (phase === 'observe')
      vi.mocked(f.ctx.containerManager.getStatus).mockImplementationOnce(failLate);
    else {
      vi.mocked(f.ctx.containerManager.getStatus).mockResolvedValue('stopped');
      vi.mocked(f.ctx.containerManager.start).mockImplementationOnce(failLate);
    }
    await expect(f.c.taskFeedbackEvents('context', 'Apply feedback', false)).rejects.toMatchObject({
      code: 'STALE_AGENT_CONTINUATION',
    });
    expect(f.pod()).toMatchObject({ status: 'queued', containerId: 'replacement' });
    expect(f.captured.getResumeEnv).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
  it('retains queued human guidance and tells feedback workers to collect its receipt', async () => {
    const f = fixture();
    f.ctx.nudgeRepo.queue('context', 'Preserved human direction');
    await f.c.taskFeedbackEvents('context', 'Apply feedback', false);
    expect(f.ctx.runtime.resume).toHaveBeenCalledWith(
      'context',
      expect.stringContaining('acknowledge_messages'),
      'container',
      f.env,
    );
    expect(f.ctx.nudgeRepo.hasPending('context')).toBe(true);
  });
  it('retains an unanswered human decision and never primes or resumes through it', async () => {
    const f = fixture();
    vi.spyOn(f.ctx.podRepo, 'hasUnansweredDecision').mockReturnValue(true);
    await expect(f.c.taskFeedbackEvents('context', 'Change', false)).rejects.toMatchObject({
      code: 'STALE_AGENT_CONTINUATION',
    });
    expect(f.captured.primeRuntimeForResume).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
  it('rechecks ownership after awaited probes and preserves the current lifecycle', async () => {
    const f = fixture();
    const original = vi.mocked(f.ctx.containerManager.execInContainer).getMockImplementation();
    if (!original) throw new Error('Missing container probe fixture');
    vi.spyOn(f.ctx.containerManager, 'execInContainer').mockImplementation(async (...args) => {
      const result = await original(...args);
      f.ctx.podRepo.incrementLifecycleGeneration('context');
      return result;
    });
    await expect(f.c.recordContinuationProvenance(f.pod(), 'container')).rejects.toMatchObject({
      code: 'STALE_AGENT_CONTINUATION',
    });
    expect(f.captured.primeRuntimeForResume).not.toHaveBeenCalled();
  });
  it('propagates environment/priming failure and rejects a missing container before external work', async () => {
    const f = fixture();
    const error = new Error('Environment failed');
    f.captured.getResumeEnv.mockRejectedValueOnce(error);
    await expect(f.c.taskFeedbackEvents('context', 'Change', false)).rejects.toBe(error);
    f.captured.primeRuntimeForResume.mockRejectedValueOnce(error);
    await expect(f.c.taskFeedbackEvents('context', 'Change', false)).rejects.toBe(error);
    f.ctx.podRepo.update('context', { containerId: null });
    await expect(f.c.taskFeedbackEvents('context', 'Change', false)).rejects.toThrow(
      'has no container',
    );
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
  });
  it('reads a late Goal service and guards Task rework until achieved and stopped', async () => {
    const f = fixture();
    expect(await f.c.beginGoalTaskRework(f.pod(), 'Task')).toBe(false);
    const { services } = createTestConfiguration(f.ctx.db);
    const launch = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Goal',
        intent: 'goal',
        overrides: {
          ai: { main: { providerAccountId: 'account', runtime: 'codex', model: 'gpt-5.5' } },
        },
      },
      services,
    );
    const repo = createGoalRepository(f.ctx.db);
    repo.create('context', 'Goal', 'codex');
    const goals = createPodGoalService({
      db: f.ctx.db,
      pods: f.ctx.podRepo,
      evidence: [],
      assertAllowed: async () => {},
      assertCurrent: () => {},
      publish: () => {},
    });
    f.live.launchConfiguration = {
      read: () => launch,
      assertCurrentCapabilities: async () => {},
      goals,
    };
    await expect(f.c.beginGoalTaskRework(f.pod(), 'Task')).rejects.toMatchObject({
      code: 'GOAL_NOT_ACHIEVED',
    });
  });
  it('persists separate Task rework while retaining achieved Goal evidence through private SQLite reopen', async () => {
    const f = fixture();
    const { services } = createTestConfiguration(f.ctx.db);
    let launch: EffectiveLaunchConfig = await resolveLaunch(
      {
        repositoryId: 'repo-a',
        task: 'Goal',
        intent: 'goal',
        overrides: {
          ai: { main: { providerAccountId: 'account', runtime: 'codex', model: 'gpt-5.5' } },
        },
      },
      services,
    );
    const dir = mkdtempSync(join(tmpdir(), 'goal-task-rework-'));
    const filename = join(dir, 'state.db');
    writeFileSync(filename, f.ctx.db.serialize());
    let db = new Database(filename);
    db.pragma('foreign_keys=ON');
    cleanups.push(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const pods = createPodRepository(db);
    const repo = createGoalRepository(db);
    repo.create('context', 'Goal', 'codex');
    db.prepare(
      "UPDATE pod_goals SET state='achieved',execution_stopped=1 WHERE pod_id='context'",
    ).run();
    const before = repo.get('context');
    const profileBefore = createProfileStore(db).get('test-profile');
    const goals = createPodGoalService({
      db,
      pods,
      evidence: [],
      assertAllowed: async () => {},
      assertCurrent: () => {},
      publish: () => {},
    });
    const c = createContinuationContext(f.live, { ...f.captured, podRepo: pods });
    f.live.launchConfiguration = {
      read: () => launch,
      assertCurrentCapabilities: async () => {},
      goals,
      beginGoalRework: async (_id, task, apply) => {
        launch = { ...launch, task, intent: 'task' };
        apply(launch);
      },
    };
    expect(await c.beginGoalTaskRework(pods.getOrThrow('context'), 'Reviewed task')).toBe(true);
    const pod = pods.getOrThrow('context');
    expect(pod).toMatchObject({
      task: 'Reviewed task',
      profileSnapshot: null,
      claudeSessionId: null,
      codexSessionId: null,
      piSessionId: null,
    });
    expect(repo.get('context')).toEqual(before);
    db.close();
    db = new Database(filename);
    db.pragma('foreign_keys=ON');
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(createGoalRepository(db).get('context')).toEqual(before);
    expect(createPodRepository(db).getOrThrow('context')).toEqual(pod);
    expect(createProfileStore(db).get('test-profile')).toEqual(profileBefore);
  });
});
