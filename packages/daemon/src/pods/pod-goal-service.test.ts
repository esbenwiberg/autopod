import type { NativeGoalObservation, NativeGoalSession } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { inspectNativeGoal } from '../runtimes/inspect-native-goal.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb, insertTestProfile } from '../test-utils/mock-helpers.js';
import { createGoalProcessRepository } from './goal-process-repository.js';
import { createGoalRepository } from './goal-repository.js';
import { createPodGoalService } from './pod-goal-service.js';
import { createPodRepository } from './pod-repository.js';

function observation(
  sequence: number,
  state: NativeGoalObservation['state'] = 'active',
): NativeGoalObservation {
  return {
    sequence,
    state,
    objective: 'Tests pass',
    nativeSessionId: 'native',
    nativeStatus: state,
    cumulativeTokens: sequence * 10,
    cumulativeSeconds: sequence,
  };
}
function nativeSession(): NativeGoalSession {
  return {
    runtime: 'codex',
    open: vi.fn(async () => 'native'),
    get: vi.fn(async () => null),
    start: vi.fn(async () => observation(1)),
    resume: vi.fn(async () => observation(1)),
    pause: vi.fn(async () => observation(3, 'paused')),
    clear: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    async *observations() {
      yield observation(2);
      yield observation(3, 'achieved');
    },
  };
}

async function fixture(verified = true) {
  const db = createTestDb();
  insertTestProfile(db);
  const { store, services } = createTestConfiguration(db);
  const ai = store.get('ai', 'ai');
  store.write({
    ...ai,
    expectedRevision: ai.revision,
    payload: { main: { providerAccountId: 'account', runtime: 'codex', model: 'gpt-5.5' } },
  });
  const config = await resolveLaunch(
    { repositoryId: 'repo-a', task: 'Tests pass', intent: 'goal' },
    services,
  );
  const pods = createPodRepository(db);
  pods.insert({
    id: 'pod',
    profileName: 'test-profile',
    task: config.task,
    status: 'running',
    model: 'gpt-5.5',
    runtime: 'codex',
    executionTarget: 'local',
    branch: 'branch',
    userId: 'operator',
    maxValidationAttempts: 3,
    skipValidation: false,
    outputMode: 'pr',
    tokenBudget: 100,
  });
  db.prepare(
    "UPDATE pods SET launch_config_digest=?, provider_id_snapshot='openai', provider_account_id_snapshot='account', input_tokens=10, output_tokens=5, token_telemetry_accuracy='complete' WHERE id='pod'",
  ).run(config.digest);
  const pod = pods.getOrThrow('pod');
  if (!pods.executionProvenance || !pods.taskExecutions) throw new Error('Missing fixture ledgers');
  const provenance = pods.executionProvenance.record('pod', pod.lifecycleGeneration, {
    version: 1,
    status: 'checked',
    runtime: 'codex',
    model: 'gpt-5.5',
    providerId: 'openai',
    providerAccountId: 'account',
    release: { commitSha: null, dirty: null, builtAt: null, source: 'unavailable' },
    cliPath: '/usr/bin/codex',
    cliVersion: '0.152.1',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    contractHash: 'a'.repeat(64),
    validationImplementationHash: null,
    capabilities: {
      streamingExec: 'supported',
      memoryLimitBytes: null,
      cpuLimit: null,
      networkMode: null,
    },
    commands: {
      requirements: [],
      unresolvedSources: [],
      deferredArtifacts: [],
      explicitDependencies: false,
    },
    diagnostics: [],
  });
  const assertCurrent = vi.fn();
  const service = createPodGoalService({
    db,
    pods,
    assertAllowed: async () => {},
    assertCurrent,
    publish: vi.fn(),
    // Synthetic acceptance identity for this fixture only; not operator/provider acceptance.
    evidence: verified
      ? [
          {
            runtime: 'codex',
            runtimeVersion: '0.152.1',
            imageDigest: provenance.imageDigest,
            backend: 'local',
            providerId: 'openai',
            observedAt: '2026-09-14T00:00:00Z',
            evidenceId: 'fixture',
            checks: {
              start: true,
              continuation: true,
              terminalEvidence: true,
              cancellation: true,
              resume: true,
              daemonRecovery: true,
              usageIncludingEvaluator: true,
              confirmedTermination: true,
            },
          },
        ]
      : [],
  });
  service.initialize(pod, config);
  const attemptId = pods.taskExecutions.beginRun('pod', pod.lifecycleGeneration, 1, {
    runtime: 'codex',
    model: 'gpt-5.5',
    providerAccountId: 'account',
  });
  const input = {
    pod,
    config,
    provenance,
    fence: { generation: pod.lifecycleGeneration, attemptId },
    assertCurrent: vi.fn(),
    session: nativeSession(),
  };
  return { db, pods, service, input, assertCurrent };
}

describe('native Goal pod lifecycle binding', () => {
  async function interrupted() {
    const f = await fixture();
    const containerId = 'c'.repeat(64);
    f.pods.update('pod', { containerId });
    const repo = createGoalRepository(f.db);
    const initial = repo.get('pod');
    if (!initial) throw new Error('Missing fixture Goal');
    repo.beginAttempt('pod', initial.revision, f.input.fence, 'codex');
    repo.bindSession('pod', f.input.fence, 'native');
    repo.observe('pod', f.input.fence, observation(10));
    const processes = createGoalProcessRepository(f.db);
    const owner = {
      podId: 'pod',
      fence: f.input.fence,
      configurationDigest: f.input.config.digest,
      accountId: 'account',
      containerId,
    };
    const identity = {
      backend: 'docker' as const,
      containerId,
      execId: 'a'.repeat(64),
      pidPath: '/tmp/.autopod-stream-exec-11111111-1111-1111-1111-111111111111.pid',
    };
    processes.record(owner, identity, 'agent');
    processes.confirmStarted(owner, identity.execId);
    f.pods.taskExecutions?.retainUnverifiedRun(f.input.fence.attemptId);
    const terminate = vi.fn(async () => 137);
    let inspectionCount = 0;
    const inspect = vi.fn<typeof inspectNativeGoal>(async (input) => {
      expect(terminate).toHaveBeenCalled();
      const ref = { ...identity, execId: (++inspectionCount).toString(16).padStart(64, '0') };
      input.hooks.processCreated(ref);
      input.hooks.processStarted(ref);
      input.observe({ ...observation(1, 'paused'), cumulativeTokens: 110, cumulativeSeconds: 11 });
    });
    const restarted = createPodGoalService({
      db: f.db,
      pods: f.pods,
      evidence: [],
      assertAllowed: async () => {},
      assertCurrent: () => {},
      publish: vi.fn(),
      recovery: {
        readConfig: () => f.input.config,
        manager: { terminateRecordedExec: terminate } as unknown as ContainerManager,
        inspect,
      },
    });
    return { ...f, restarted, terminate, inspect, processes, owner, identity };
  }
  it('recovers a lost process before inspecting native state and settling the durable attempt', async () => {
    const f = await interrupted();
    try {
      const goal = await f.restarted.recover('pod');
      expect(goal).toMatchObject({ state: 'paused', executionStopped: true, observedTokens: 110 });
      expect(f.terminate).toHaveBeenCalledWith(
        expect.objectContaining({ execId: f.identity.execId }),
      );
      expect(f.pods.taskExecutions?.hasUnverifiedTermination('pod')).toBe(false);
      expect(
        f.db
          .prepare('SELECT outcome,failure_category FROM task_agent_runs WHERE id=?')
          .get(f.input.fence.attemptId),
      ).toEqual({ outcome: 'paused', failure_category: 'native_goal_recovered' });
      await f.restarted.recover('pod');
      expect(f.inspect).toHaveBeenCalledOnce();
      expect(f.restarted.get('pod')?.observedTokens).toBe(110);
    } finally {
      f.db.close();
    }
  });
  it('does not inspect, release the task budget, or confirm cancellation after uncertain termination', async () => {
    const f = await interrupted();
    try {
      f.terminate.mockRejectedValue(new Error('Disconnected'));
      await expect(f.restarted.control('pod', 'cancel')).rejects.toThrow('Disconnected');
      expect(f.inspect).not.toHaveBeenCalled();
      expect(f.restarted.get('pod')).toMatchObject({
        executionStopped: false,
        controlIntent: 'cancel',
      });
      expect(f.pods.taskExecutions?.hasUnverifiedTermination('pod')).toBe(true);
      f.terminate.mockResolvedValue(137);
      expect(await f.restarted.recover('pod')).toMatchObject({
        state: 'cancelled',
        executionStopped: true,
      });
    } finally {
      f.db.close();
    }
  });
  it('retains an interrupted inspection process and terminates it before a replacement inspector', async () => {
    const f = await interrupted();
    try {
      f.inspect.mockImplementationOnce(async (input) => {
        const ref = { ...f.identity, execId: 'b'.repeat(64) };
        input.hooks.processCreated(ref);
        input.hooks.processStarted(ref);
        throw new Error('Inspector exit unconfirmed');
      });
      await expect(f.restarted.recover('pod')).rejects.toThrow('Inspector exit unconfirmed');
      expect(f.restarted.get('pod')?.executionStopped).toBe(false);
      await f.restarted.recover('pod');
      expect(f.terminate.mock.calls.map((call) => call[0].execId)).toEqual([
        f.identity.execId,
        'b'.repeat(64),
      ]);
      expect(f.restarted.get('pod')?.observedTokens).toBe(110);
    } finally {
      f.db.close();
    }
  });
  it('settles a crash after confirmed Goal stop but before the task runner finishes', async () => {
    const f = await interrupted();
    try {
      f.processes.confirmStopped(f.owner, f.identity.execId, 137);
      const repo = createGoalRepository(f.db);
      const goal = repo.get('pod');
      if (!goal) throw new Error('Missing fixture');
      repo.requestControl('pod', goal.revision, 'pause');
      repo.confirmStopped('pod', f.input.fence);
      expect(f.pods.taskExecutions?.hasActiveRun('pod')).toBe(true);
      expect(await f.restarted.recover('pod')).toMatchObject({
        state: 'paused',
        executionStopped: true,
      });
      expect(f.pods.taskExecutions?.hasActiveRun('pod')).toBe(false);
      expect(f.terminate).not.toHaveBeenCalled();
      expect(f.inspect).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('closes an unacknowledged-start crash window after the exact Docker exec has an observed exit', async () => {
    const f = await interrupted();
    try {
      const unknown = { ...f.identity, execId: 'f'.repeat(64) };
      f.processes.record(f.owner, unknown, 'inspection');
      expect(await f.restarted.recover('pod')).toMatchObject({
        state: 'paused',
        executionStopped: true,
      });
      expect(f.terminate).toHaveBeenCalledTimes(2);
      expect(f.inspect).toHaveBeenCalledOnce();
      expect(
        f.db
          .prepare('SELECT stopped_at FROM pod_goal_processes WHERE exec_id=?')
          .get(unknown.execId),
      ).toEqual({ stopped_at: expect.any(String) });
      expect(f.pods.taskExecutions?.hasUnverifiedTermination('pod')).toBe(false);
    } finally {
      f.db.close();
    }
  });
  it('refuses a changed container and cannot rewrite the saved process identity', async () => {
    const f = await interrupted();
    try {
      expect(() =>
        f.db.prepare("UPDATE pod_goal_processes SET container_id='other'").run(),
      ).toThrow('immutable');
      f.pods.update('pod', { containerId: 'd'.repeat(64) });
      await expect(f.restarted.recover('pod')).rejects.toMatchObject({ code: 'GOAL_SUPERSEDED' });
      expect(f.terminate).not.toHaveBeenCalled();
      expect(f.inspect).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('rejects unverified provider/image execution before opening the native process', async () => {
    const f = await fixture(false);
    try {
      await expect(f.service.run(f.input)).rejects.toMatchObject({ code: 'GOAL_UNAVAILABLE' });
      expect(f.input.session.open).not.toHaveBeenCalled();
      expect(f.service.get('pod')?.executionStopped).toBe(true);
    } finally {
      f.db.close();
    }
  });
  it('subtracts prior main and review usage and leaves achieved work for daemon validation', async () => {
    const f = await fixture();
    try {
      f.db
        .prepare(`INSERT INTO isolated_reviewer_runs(id,pod_id,lifecycle_generation,configuration_digest,account_id,runtime,model,execution_target,state,cleanup,input_tokens,output_tokens,created_at,updated_at)
        VALUES('review','pod',1,?,'account','codex','gpt-5.5','local','completed','clean',20,5,'now','now')`)
        .run(f.input.config.digest);
      const goal = await f.service.run(f.input);
      expect(f.input.session.start).toHaveBeenCalledWith('Tests pass', 60);
      expect(goal).toMatchObject({ state: 'achieved', observedTokens: 30, executionStopped: true });
      expect(f.pods.taskExecutions?.snapshot('pod')).toMatchObject({
        recordedTotalTokens: 70,
        recordedUnclassifiedTokens: 30,
      });
      expect(f.pods.getOrThrow('pod').status).toBe('running');
      expect(f.input.session.stop).toHaveBeenCalledOnce();
    } finally {
      f.db.close();
    }
  });
  it('cancels a queued Goal without inventing a native session or process', async () => {
    const f = await fixture();
    try {
      const goal = f.service.get('pod');
      if (!goal) throw new Error('Missing fixture Goal');
      const revision = goal.revision;
      await expect(f.service.control('pod', 'cancel', revision + 1)).rejects.toMatchObject({
        code: 'GOAL_CHANGED',
      });
      expect(await f.service.control('pod', 'cancel', revision)).toMatchObject({
        state: 'cancelled',
        executionStopped: true,
        nativeSessionId: null,
      });
      expect(f.input.session.open).not.toHaveBeenCalled();
    } finally {
      f.db.close();
    }
  });
  it('resumes the same native session without resetting cumulative usage or its remaining budget', async () => {
    const f = await fixture();
    try {
      f.input.session.observations = async function* () {
        yield observation(2, 'paused');
      };
      const paused = await f.service.run(f.input);
      expect(paused).toMatchObject({ state: 'paused', observedTokens: 20, executionStopped: true });
      const ledger = f.pods.taskExecutions;
      if (!ledger) throw new Error('Missing fixture task ledger');
      ledger.finishRun(f.input.fence.attemptId, 'paused', null);
      f.service.prepareResume('pod', paused.revision);
      const generation = f.pods.incrementLifecycleGeneration('pod');
      const attemptId = ledger.beginRun('pod', generation, 1, {
        runtime: 'codex',
        model: 'gpt-5.5',
        providerAccountId: 'account',
      });
      const resumed = nativeSession();
      vi.mocked(resumed.get).mockResolvedValue({ ...observation(2, 'paused'), sequence: 0 });
      vi.mocked(resumed.resume).mockResolvedValue({ ...observation(2), sequence: 1 });
      resumed.observations = async function* () {
        yield { ...observation(3, 'achieved'), sequence: 2 };
      };
      const goal = await f.service.run({
        ...f.input,
        pod: f.pods.getOrThrow('pod'),
        provenance: { ...f.input.provenance, generation },
        fence: { generation, attemptId },
        session: resumed,
      });
      expect(resumed.open).toHaveBeenCalledWith('native');
      expect(resumed.start).not.toHaveBeenCalled();
      expect(resumed.resume).toHaveBeenCalledWith(65);
      expect(goal).toMatchObject({ state: 'achieved', observedTokens: 30, executionStopped: true });
      expect(ledger.snapshot('pod').recordedTotalTokens).toBe(45);
    } finally {
      f.db.close();
    }
  });
});
