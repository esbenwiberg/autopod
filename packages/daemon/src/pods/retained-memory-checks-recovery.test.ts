import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainedContinuationLaunch } from '../configuration/retained-continuation-launch.js';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import {
  materializeCheckpointFixture,
  retainedCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { INTEGRATION_TEST_TIMEOUT_MS } from '../test-utils/test-budgets.js';
import { memoryCommandHash } from '../validation/test-process-memory.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import { checkpointHash, checkpointResourceIdentity } from './retained-checkpoint-repository.js';

vi.setConfig({ testTimeout: INTEGRATION_TEST_TIMEOUT_MS });
const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const record of f.recovery.list(f.podId)) await f.recovery.wait(record.id);
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});
const command = 'node --test --experimental-test-isolation=none tests/memory.test.js';
const GiB = 1024 ** 3;

async function fixture(status: 'failed' | 'review_required' = 'review_required', evidence = true) {
  const f = await retainedCheckpointFixture('validation', true, true, true, 'local', undefined, {
    testCommand: command,
  });
  fixtures.push(f);
  vi.stubEnv('DATA_DIR', f.root);
  await materializeCheckpointFixture(f);
  const launch = f.ctx.deps.launchConfiguration!;
  Object.assign(f.deps, {
    readLaunch: launch.read,
    executionSettings: launch.executionSettings,
    executionForPod: (pod: { id: string }) => launch.executionSettings(launch.read(pod.id)!),
  });
  f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
    const source = await f.worktrees.inspectSourceAdoption(input.worktreePath, input.branch);
    return { head: source.commitSha, tree: source.treeSha, baseCommitSha: f.input.checkpointHead };
  });
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  await f.recovery.continueRetained(f.podId, f.input, f.actor);
  await f.recovery.wait(f.input.id);
  const replacement = '2'.repeat(64);
  let currentIdentity = checkpointResourceIdentity(f.podId, f.input.id, 2);
  f.cm.getResourceKey = vi.fn(async (id) =>
    id === f.containerId ? f.resourceKey : `docker:fixture:${id}`,
  );
  f.cm.getStatus = vi.fn(async (id) => (id === '4'.repeat(64) ? 'running' : 'stopped'));
  f.cm.getExecutionMetadata = vi.fn(async (id) => ({
    podId: f.podId,
    resourceIdentity: currentIdentity,
    imageDigest: 'sha256:' + '3'.repeat(64),
    memoryLimitBytes: id === replacement ? 8 * GiB : 12 * GiB,
    cpuLimit: 4,
    networkMode: 'fixture',
  }));
  const priorMemory = {
    version: 1 as const,
    kind: 'node-heap' as const,
    commandHash: memoryCommandHash(command),
    containerId: replacement,
    resourceKey: `docker:fixture:${replacement}`,
    imageDigest: 'sha256:' + '3'.repeat(64),
    heapLimitBytes: 2 * GiB,
    containerLimitBytes: 8 * GiB,
    processId: 100,
  };
  await f.recovery.process(f.podId, async () => {
    const ledger = f.ctx.podRepo.taskRetries!;
    const previous = f.ctx.db
      .prepare('SELECT binding_hash FROM task_retry_attempts ORDER BY rowid DESC LIMIT 1')
      .get() as { binding_hash: string };
    ledger.authorize(
      f.podId,
      'prior-fixture-check',
      'One deterministic failed check retaining original accounting',
      f.actor,
    );
    const admission = ledger.admit(
      f.podId,
      2,
      {
        source: 'f'.repeat(64),
        contract: null,
        commands: null,
        environment: null,
        implementation: null,
      },
      previous.binding_hash,
      [0, 0],
    );
    ledger.start(admission.id);
    const result = createFailingValidationResult(f.podId, 1);
    result.infrastructureFailure = {
      phase: 'test',
      code: 'PROCESS_MEMORY_EXHAUSTED',
      retryable: false,
      message: 'FATAL ERROR: JavaScript heap out of memory',
    };
    result.test = {
      status: 'skip',
      duration: 42,
      stderr: '[100:fixture] FATAL ERROR: JavaScript heap out of memory',
      ...(evidence ? { memoryEvidence: priorMemory } : {}),
    };
    f.ctx.podRepo.update(f.podId, {
      containerId: replacement,
      status,
      validationAttempts: 1,
      lastValidationResult: result,
    });
    ledger.finish(admission.id, 'nonretryable', 42);
  });
  const prior = f.recovery.list(f.podId)[0]!;
  const parent = launch.read(f.podId)!;
  const execution = {
    profileId: 'qualified-memory-fixture',
    parentDigest: parent.digest,
    environment: parent.environment,
    resolvedEnvironment: parent.resolvedEnvironment,
    target: parent.execution.target,
    main: { ...parent.resolvedExecution.main, memoryGb: 12, cpus: 4 },
    resolvedExecution: {
      ...parent.resolvedExecution,
      main: { ...parent.resolvedExecution.main, memoryGb: 12, cpus: 4 },
    },
    digest: '',
  };
  execution.digest = retainedContinuationLaunch(parent, f.podId, execution).digest;
  f.deps.previewExecution = vi.fn(async () => execution);
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  const request = {
    ...f.input,
    id: 'memory-checks-successor',
    checkpointHead: prior.prepared!.head,
    expectedGeneration: 2,
    expectedResultHash: checkpointHash(f.pod().lastValidationResult),
    mode: 'checks' as const,
    qualification: 'Require actual effective command heap improvement before dispatch',
    executionProfileId: execution.profileId,
    expectedExecutionDigest: execution.digest,
    reason: 'Retry the exact saved checks with measured effective memory improvement',
  };
  let heap = 4 * GiB;
  const execute = vi.mocked(f.cm.execInContainer).getMockImplementation()!;
  vi.mocked(f.cm.execInContainer).mockImplementation(async (...args) => {
    if (args[1].some((arg) => arg.includes('getHeapStatistics')))
      return {
        stdout: JSON.stringify({ heap, container: 12 * GiB, pid: 200 }),
        stderr: '',
        exitCode: 0,
      };
    return execute(...args);
  });
  vi.mocked(f.cm.spawn).mockImplementation(async (config) => {
    currentIdentity = config.resourceIdentity!;
    return '4'.repeat(64);
  });
  const reportChecks = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
  vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => ({
    ...(await reportChecks(config)),
    test: {
      status: 'pass',
      duration: 2,
      memoryEvidence: {
        ...priorMemory,
        heapLimitBytes: heap,
        containerLimitBytes: 12 * GiB,
        containerId: config.containerId,
        resourceKey: `docker:fixture:${config.containerId}`,
        processId: 200,
      },
    },
    taskReview: {
      status: 'pass',
      reasoning: 'Deterministic independent review double',
      issues: [],
      model: 'fixture',
      screenshots: [],
      diff: config.diff,
    },
  }));
  return {
    f,
    request,
    prior,
    priorMemory,
    setHeap: (value: number) => {
      heap = value;
    },
  };
}

describe('retained memory checks through SQLite, real retained Git and production controller', () => {
  it.each([
    'failed',
    'review_required',
  ] as const)('runs one qualified checks admission from %s without coding or delivery', async (status) => {
    const { f, request, prior } = await fixture(status);
    const before = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    expect(f.recovery.inspect(f.podId).memoryRecovery?.state).toBe('requires_candidate');
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    await f.recovery.wait(request.id);
    f.ctx.podRepo.taskRetries!.authorize(
      f.podId,
      'explicit-memory-fixture',
      'Existing allowance explicitly permits one fresh validation attempt',
      f.actor,
    );
    await f.manager.processPod(f.podId);
    const next = f.recovery.list(f.podId).find((r) => r.id === request.id)!;
    expect(next.checked?.result.overall).toBe('pass');
    expect(next.checked?.source).toMatchObject({
      head: prior.prepared!.head,
      tree: prior.prepared!.tree,
    });
    expect(f.pod().status).toBe('validated');
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).agentRunCount).toBe(
      before.agentRunCount,
    );
    expect(f.recovery.list(f.podId).find((r) => r.id === prior.id)?.checked).toEqual(prior.checked);
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    await f.manager.processPod(f.podId).catch(() => {});
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
  });
  it('keeps legacy missing process evidence unavailable, without stopping or claiming', async () => {
    const { f, request } = await fixture('review_required', false);
    expect(f.recovery.inspect(f.podId).memoryRecovery).toMatchObject({
      state: 'unavailable',
      priorMemory: null,
    });
    await expect(f.recovery.recoverInfrastructure(f.podId, request, f.actor)).rejects.toMatchObject(
      { code: 'MEMORY_RECOVERY_UNAVAILABLE' },
    );
    expect(f.recovery.list(f.podId)).toHaveLength(1);
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it.each([
    'unchanged-heap',
    'unknown-heap',
    'no-permission',
    'wrong-owner',
    'source-drift',
    'allocation-regressed',
    'wrong-allocation-owner',
    'owner-changed-after-claim',
  ] as const)('never dispatches checks for %s', async (fault) => {
    const { f, request, setHeap } = await fixture();
    if (fault === 'wrong-owner') {
      await expect(
        f.recovery.recoverInfrastructure(f.podId, request, { type: 'human', userId: 'other' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      return;
    }
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    await f.recovery.wait(request.id);
    if (fault !== 'no-permission')
      f.ctx.podRepo.taskRetries!.authorize(
        f.podId,
        'negative-memory-fixture',
        'Explicit fixture retry permission does not waive memory/source checks',
        f.actor,
      );
    if (fault === 'unchanged-heap') setHeap(2 * GiB);
    if (fault === 'unknown-heap') setHeap(0);
    if (fault === 'owner-changed-after-claim')
      f.ctx.db.prepare('UPDATE pods SET user_id=? WHERE id=?').run('other-owner', f.podId);
    if (fault === 'allocation-regressed' || fault === 'wrong-allocation-owner') {
      const metadata = f.cm.getExecutionMetadata!;
      f.cm.getExecutionMetadata = vi.fn(async (id) => ({
        ...(await metadata(id)),
        ...(id === '4'.repeat(64)
          ? fault === 'allocation-regressed'
            ? { memoryLimitBytes: 6 * GiB }
            : { resourceIdentity: 'another-request' }
          : {}),
      }));
    }
    if (fault === 'source-drift')
      f.worktrees.inspectSourceAdoption.mockResolvedValue({
        branch: f.pod().branch,
        commitSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
        worktreeClean: true,
      });
    await f.manager.processPod(f.podId).catch(() => {});
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(
      f.recovery.list(f.podId).find((r) => r.id === request.id)?.checked?.result.overall,
    ).not.toBe('pass');
  });
  it('observes a lost stop reply across controller recreation without repeating the effect', async () => {
    const { f, request } = await fixture();
    f.cm.getStatus = vi.fn(async () => 'running');
    vi.mocked(f.cm.stop).mockRejectedValueOnce(new Error('Reply lost after dispatch'));
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    await f.recovery.wait(request.id);
    f.recovery = createRetainedCheckpointRecovery(f.deps);
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    expect(f.recovery.list(f.podId).find((r) => r.id === request.id)?.activated).toBeNull();
    f.cm.getStatus = vi.fn(async () => 'stopped');
    await f.recovery.reconcileInfrastructure(f.podId, request, f.actor);
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    expect(f.recovery.list(f.podId).find((r) => r.id === request.id)?.activated).toEqual({
      generation: 3,
    });
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
  });
  it('does not replay an uncertain validation dispatch after controller recreation', async () => {
    const { f, request } = await fixture();
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    await f.recovery.wait(request.id);
    f.ctx.podRepo.taskRetries!.authorize(
      f.podId,
      'lost-check-fixture',
      'One admitted check with deliberately lost executor outcome',
      f.actor,
    );
    vi.mocked(f.ctx.validationEngine.validate).mockRejectedValueOnce(
      new Error('Executor reply lost'),
    );
    await f.manager.processPod(f.podId).catch(() => {});
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    const saved = f.recovery.list(f.podId).find((r) => r.id === request.id)!;
    expect(saved.checking).not.toBeNull();
    expect(saved.checked?.result.overall).not.toBe('pass');
    f.recovery = createRetainedCheckpointRecovery(f.deps);
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    await f.manager.processPod(f.podId).catch(() => {});
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('does not widen review-required status for unrelated infrastructure failures', async () => {
    const { f, request } = await fixture();
    f.ctx.podRepo.update(f.podId, {
      lastValidationResult: {
        ...f.pod().lastValidationResult!,
        infrastructureFailure: {
          phase: 'test',
          code: 'VALIDATION_RUNNER_CRASHED',
          message: 'Unclassified worker exit',
          retryable: false,
        },
      },
    });
    await expect(
      f.recovery.recoverInfrastructure(
        f.podId,
        { ...request, expectedResultHash: checkpointHash(f.pod().lastValidationResult) },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_RECOVERY_BLOCKED' });
    expect(f.recovery.list(f.podId)).toHaveLength(1);
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
});
