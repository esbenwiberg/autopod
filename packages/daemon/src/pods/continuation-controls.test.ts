import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveLaunchConfig, ValidationResult } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createProfileStore } from '../profiles/index.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import {
  createMockContainerManager,
  createTestDb,
  insertTestProfile,
} from '../test-utils/mock-helpers.js';
import { createContinuationControls } from './continuation-controls.js';
import type { ContinuationCaptured, ContinuationLiveDependencies } from './continuation-ports.js';
import { createGoalRepository } from './goal-repository.js';
import { createPodGoalService } from './pod-goal-service.js';
import { createPodRepository } from './pod-repository.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function validation(): ValidationResult {
  return {
    podId: 'control',
    attempt: 1,
    timestamp: '2026-10-18',
    overall: 'pass',
    smoke: {
      status: 'pass',
      build: { status: 'pass', output: '', duration: 0 },
      health: { status: 'pass', url: '', responseCode: 200, duration: 0 },
      pages: [],
    },
    taskReview: null,
    duration: 1,
  };
}
function fixture(disk = false) {
  let db = createTestDb();
  insertTestProfile(db);
  let directory: string | undefined;
  let filename: string | undefined;
  if (disk) {
    directory = mkdtempSync(join(tmpdir(), 'goal-resume-'));
    filename = join(directory, 'state.db');
    writeFileSync(filename, db.serialize());
    db.close();
    db = new Database(filename);
    db.pragma('foreign_keys=ON');
  }
  cleanups.push(() => {
    db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const pods = createPodRepository(db);
  const profiles = createProfileStore(db);
  const cm = createMockContainerManager();
  pods.insert({
    id: 'control',
    profileName: 'test-profile',
    task: 'Task',
    status: 'failed',
    runtime: 'codex',
    model: 'gpt-5.5',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
  });
  pods.update('control', { worktreePath: '/tmp/control-fixture', containerId: 'container' });
  const live: ContinuationLiveDependencies = {};
  const captured = {
    podRepo: pods,
    containerManagerFactory: { get: vi.fn(() => cm) },
    enqueueSession: vi.fn(),
    logger: pino({ enabled: false }),
    assertExecutionTerminationVerified: vi.fn(),
    assertGuidanceCollected: vi.fn(),
    hasDurableAgentExecutionEvidence: vi.fn(() => false),
    infrastructureResumeRuns: new Map<string, Promise<void>>(),
    artifactResumeRuns: new Map<string, Promise<void>>(),
    activeAgentRuns: new Map<string, unknown>(),
    resolveEffectiveBoundProfile: () => profiles.get('test-profile'),
    ownsLifecycle: vi.fn(() => true),
    isRetryableFixDeliveryFailure: vi.fn(() => false),
    completeFixPodAfterPush: vi.fn(async () => {}),
    emitActivityStatus: vi.fn(),
    pushAndCreatePr: vi.fn(async () => 'https://github.com/fixture/repo/pull/1'),
    transition: vi.fn<ContinuationCaptured['transition']>((pod, status, extra) => {
      pods.update(pod.id, { ...extra, status });
      return pods.getOrThrow(pod.id);
    }),
  };
  const calls = {
    handleCompletion: vi.fn(async () => {}),
    revalidateSession: vi.fn(async (_id: string, _options?: { force?: boolean }) => {}),
    approveSession: vi.fn(async (_id: string, _options?: { automation?: boolean }) => {}),
  };
  const c = createContinuationControls(live, captured);
  return {
    get db() {
      return db;
    },
    pods,
    profiles,
    cm,
    live,
    captured,
    c,
    calls,
    pod: () => pods.getOrThrow('control'),
    async goal() {
      const { services } = createTestConfiguration(db);
      const config: EffectiveLaunchConfig = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Task',
          intent: 'goal',
          overrides: {
            ai: { main: { providerAccountId: 'account', runtime: 'codex', model: 'gpt-5.5' } },
          },
        },
        services,
      );
      const repo = createGoalRepository(db);
      const goal = repo.create('control', 'Task', 'codex');
      db.prepare(
        "UPDATE pod_goals SET state='paused',execution_stopped=1 WHERE pod_id='control'",
      ).run();
      const goals = createPodGoalService({
        db,
        pods,
        evidence: [],
        assertAllowed: async () => {},
        assertCurrent: () => {},
        publish: () => {},
      });
      live.launchConfiguration = {
        read: () => config,
        assertCurrentCapabilities: vi.fn(async () => {}),
        goals,
      };
      return { repo, goal, goals, config };
    },
    reopen() {
      if (!filename) throw new Error('Expected private file fixture');
      db.close();
      db = new Database(filename);
      db.pragma('foreign_keys=ON');
      return {
        pods: createPodRepository(db),
        goals: createGoalRepository(db),
        profiles: createProfileStore(db),
      };
    },
  };
}
describe('continuation controls', () => {
  it('constructs inertly and revalidates legacy failure with exact receiver arguments', async () => {
    const f = fixture();
    expect(f.captured.assertExecutionTerminationVerified).not.toHaveBeenCalled();
    await expect(f.c.resumePod.call(f.calls, 'control')).resolves.toEqual({ action: 'revalidate' });
    expect(f.calls.revalidateSession).toHaveBeenCalledExactlyOnceWith('control', { force: true });
    expect(f.calls.handleCompletion).not.toHaveBeenCalled();
    expect(f.captured.assertExecutionTerminationVerified).toHaveBeenCalledExactlyOnceWith(
      'control',
    );
    expect(f.captured.assertGuidanceCollected).toHaveBeenCalledExactlyOnceWith('control');
  });
  it('retains termination/guidance errors before starting recovery', async () => {
    const f = fixture();
    const error = new Error('Human decision');
    f.captured.assertGuidanceCollected.mockImplementationOnce(() => {
      throw error;
    });
    await expect(f.c.resumePod.call(f.calls, 'control')).rejects.toBe(error);
    expect(f.calls.revalidateSession).not.toHaveBeenCalled();
  });
  it('retries PR delivery and looks up the current approval receiver in the deferred callback', async () => {
    const f = fixture();
    f.pods.update('control', { lastValidationResult: validation(), autoApprove: true });
    await expect(f.c.resumePod.call(f.calls, 'control')).resolves.toEqual({ action: 'retry-pr' });
    const approve = vi.fn(async () => {});
    f.calls.approveSession = approve;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(approve).toHaveBeenCalledExactlyOnceWith('control', { automation: true });
    expect(f.pod().status).toBe('validated');
    expect(f.pod().prUrl).toBe('https://github.com/fixture/repo/pull/1');
    expect(f.calls.revalidateSession).not.toHaveBeenCalled();
  });
  it('retries retained validated fix delivery without agent or validation work', async () => {
    const f = fixture();
    f.captured.isRetryableFixDeliveryFailure.mockReturnValue(true);
    await expect(f.c.resumePod.call(f.calls, 'control')).resolves.toEqual({
      action: 'retry-fix-delivery',
    });
    expect(f.captured.completeFixPodAfterPush).toHaveBeenCalledOnce();
    expect(f.calls.revalidateSession).not.toHaveBeenCalled();
  });
  it('coalesces infrastructure revalidation and removes the shared promise on settlement', async () => {
    const f = fixture();
    const pending = gate();
    f.calls.revalidateSession.mockReturnValue(pending.promise);
    f.pods.update('control', {
      status: 'review_required',
      lastValidationResult: {
        ...validation(),
        overall: 'fail',
        infrastructureFailure: {
          phase: 'test',
          code: 'TOOL_UNAVAILABLE',
          message: 'Synthetic',
          retryable: true,
        },
      },
    });
    await expect(f.c.resumePod.call(f.calls, 'control')).resolves.toEqual({ action: 'revalidate' });
    const shared = f.captured.infrastructureResumeRuns.get('control');
    expect(shared).toBeDefined();
    await f.c.resumePod.call(f.calls, 'control');
    expect(f.calls.revalidateSession).toHaveBeenCalledOnce();
    pending.release();
    await shared;
    expect(f.captured.infrastructureResumeRuns.size).toBe(0);
  });
  it('coalesces artifact recovery and clears its shared map after original completion succeeds', async () => {
    const f = fixture();
    const pending = gate();
    f.pods.update('control', {
      options: { ...f.pod().options, output: 'artifact', validate: false },
    });
    f.pods.completionJournal?.settle(f.pod(), 'Settled result');
    f.pods.completionJournal?.mark(f.pod(), 'preserving');
    f.calls.handleCompletion.mockImplementation(async () => {
      await pending.promise;
      f.pods.update('control', { status: 'complete' });
    });
    const a = f.c.resumePod.call(f.calls, 'control');
    await Promise.resolve();
    const b = f.c.resumePod.call(f.calls, 'control');
    expect(f.captured.artifactResumeRuns.has('control')).toBe(true);
    pending.release();
    expect(await Promise.all([a, b])).toEqual([
      { action: 'collect-artifacts' },
      { action: 'collect-artifacts' },
    ]);
    expect(f.calls.handleCompletion).toHaveBeenCalledOnce();
    expect(f.captured.artifactResumeRuns.size).toBe(0);
    expect(f.calls.revalidateSession).not.toHaveBeenCalled();
  });
  it('retains a failed artifact collection error and cleans coalescing state', async () => {
    const f = fixture();
    f.pods.update('control', {
      options: { ...f.pod().options, output: 'artifact', validate: false },
    });
    f.pods.completionJournal?.settle(f.pod(), 'Settled');
    f.pods.completionJournal?.mark(f.pod(), 'preserving');
    const error = new Error('Collection failed');
    f.calls.handleCompletion.mockRejectedValueOnce(error);
    await expect(f.c.resumePod.call(f.calls, 'control')).rejects.toBe(error);
    expect(f.captured.artifactResumeRuns.size).toBe(0);
  });
  it('rechecks safe sandbox generation after awaited kill before restarting work', async () => {
    const f = fixture();
    f.pods.update('control', { containerId: null });
    f.pods.update('control', {
      executionTarget: 'sandbox',
      infrastructureFailure: {
        source: 'azure-sandbox',
        code: 'AZURE_SANDBOX_TRANSIENT_FORBIDDEN',
        phase: 'agent',
        statusCode: 403,
        diagnostics: {},
        safeAgentRestart: true,
        recoveryDisposition: 'automatic_retry_exhausted',
        occurredAt: '2026-10-18',
        retryNotBefore: null,
      },
    });
    f.pods.update('control', { containerId: 'container' });
    vi.mocked(f.cm.kill).mockImplementationOnce(async () => {
      f.pods.incrementLifecycleGeneration('control');
    });
    await expect(f.c.resumePod.call(f.calls, 'control')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(f.captured.enqueueSession).not.toHaveBeenCalled();
    expect(f.calls.revalidateSession).not.toHaveBeenCalled();
  });
  it('guards native Goal task work and requires a matching revision for native resume', async () => {
    const f = fixture();
    const g = await f.goal();
    expect(() => f.c.assertCanRework('control')).toThrow(
      expect.objectContaining({ code: 'GOAL_NATIVE_RESUME_REQUIRED' }),
    );
    await expect(f.c.resumePod.call(f.calls, 'control')).rejects.toMatchObject({
      code: 'GOAL_NATIVE_RESUME_REQUIRED',
    });
    const before = f.pod();
    await expect(f.c.resumeNativeGoal('control', g.goal.revision + 20)).rejects.toMatchObject({
      code: 'GOAL_CHANGED',
    });
    expect(f.pod()).toEqual(before);
    expect(f.captured.enqueueSession).not.toHaveBeenCalled();
  });
  it('rejects native Goal resume when another run owns execution', async () => {
    const f = fixture();
    const g = await f.goal();
    f.captured.activeAgentRuns.set('control', {});
    await expect(f.c.resumeNativeGoal('control', g.goal.revision)).rejects.toMatchObject({
      code: 'GOAL_RESUME_UNAVAILABLE',
    });
  });
  it('rejects a superseding lifecycle after native capability checking', async () => {
    const f = fixture();
    const g = await f.goal();
    const configuration = f.live.launchConfiguration;
    if (!configuration) throw new Error('Missing launch fixture');
    configuration.assertCurrentCapabilities = async () => {
      f.pods.incrementLifecycleGeneration('control');
    };
    await expect(f.c.resumeNativeGoal('control', g.goal.revision)).rejects.toMatchObject({
      code: 'GOAL_SUPERSEDED',
    });
    expect(f.captured.enqueueSession).not.toHaveBeenCalled();
  });
  it('retains an exhausted task budget before native Goal resume admission', async () => {
    const f = fixture();
    const g = await f.goal();
    f.pods.update('control', {
      tokenBudget: 1,
      inputTokens: 2,
      outputTokens: 0,
      tokenTelemetryAccuracy: 'complete',
    });
    expect(f.pods.taskExecutions?.snapshot('control').budgetCheck?.status).toBe('exhausted');
    await expect(f.c.resumeNativeGoal('control', g.goal.revision)).rejects.toMatchObject({
      code: 'GOAL_BUDGET_UNAVAILABLE',
    });
    expect(f.captured.enqueueSession).not.toHaveBeenCalled();
    expect(g.repo.get('control')?.controlIntent).toBeNull();
  });
  it('persists revision-bound native Goal resume and queues after commit through private SQLite reopen', async () => {
    const f = fixture(true);
    const g = await f.goal();
    const profile = f.profiles.get('test-profile');
    const generation = f.pod().lifecycleGeneration;
    f.captured.enqueueSession.mockImplementation(() => {
      expect(f.db.inTransaction).toBe(false);
      expect(f.pod().status).toBe('queued');
    });
    await f.c.resumeNativeGoal('control', g.goal.revision);
    expect(f.captured.enqueueSession).toHaveBeenCalledExactlyOnceWith('control');
    expect(f.pod()).toMatchObject({
      status: 'queued',
      lifecycleGeneration: generation + 1,
      recoveryWorktreePath: '/tmp/control-fixture',
    });
    expect(g.repo.get('control')).toMatchObject({
      state: 'paused',
      executionStopped: true,
      controlIntent: 'resume',
    });
    const pod = f.pod();
    const goal = g.repo.get('control');
    const next = f.reopen();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(next.pods.getOrThrow('control')).toEqual(pod);
    expect(next.goals.get('control')).toEqual(goal);
    expect(next.profiles.get('test-profile')).toEqual(profile);
  });
});
