import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainedContinuationLaunch } from '../configuration/retained-continuation-launch.js';
import { createFailingValidationResult } from '../test-utils/mock-helpers.js';
import { retainedCheckpointFixture } from '../test-utils/retained-checkpoint-helpers.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import { checkpointHash, checkpointResourceIdentity } from './retained-checkpoint-repository.js';

const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const record of f.recovery.list(f.podId)) await f.recovery.wait(record.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function failedChecks(withSnapshot = false) {
  const f = await retainedCheckpointFixture('validation', true, true, true, 'local', undefined, {
    buildEnv: { CI: { value: 'true' }, XPM_BICEP: { value: '/pinned/bicep' } },
  });
  fixtures.push(f);
  const launch = f.ctx.deps.launchConfiguration!;
  f.deps.readLaunch = launch.read;
  f.deps.executionSettings = launch.executionSettings;
  f.deps.executionForPod = (pod) => launch.executionSettings(launch.read(pod.id)!);
  f.worktrees.selectRetainedContinuationSource = vi.fn(async () => ({
    head: f.prepared.head,
    tree: f.prepared.tree,
    baseCommitSha: '1'.repeat(40),
  }));
  f.recovery = createRetainedCheckpointRecovery(f.deps);
  await f.recovery.continueRetained(f.podId, f.input, f.actor);
  await f.recovery.wait(f.input.id);
  const replacement = '2'.repeat(64);
  f.cm.getResourceKey = vi.fn(async (id) =>
    id === replacement ? 'docker:fixture:' + replacement : f.resourceKey,
  );
  f.cm.getStatus = vi.fn(async (id) => (id === replacement ? 'running' : 'stopped'));
  f.cm.getExecutionMetadata = vi.fn(async () => ({
    podId: f.podId,
    resourceIdentity: checkpointResourceIdentity(f.podId, f.input.id, 2),
    imageDigest: 'sha256:' + '3'.repeat(64),
    memoryLimitBytes: 8 * 1024 ** 3,
    cpuLimit: 4,
    networkMode: 'fixture',
  }));
  await f.recovery.process(f.podId, async () => {
    const ledger = f.ctx.podRepo.taskRetries!;
    const previous = f.ctx.db
      .prepare('SELECT binding_hash FROM task_retry_attempts ORDER BY rowid DESC LIMIT 1')
      .get() as { binding_hash: string };
    ledger.authorize(
      f.podId,
      'fixture-one-check',
      'One fresh fixture validation retaining all original evidence',
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
    f.ctx.podRepo.update(f.podId, {
      containerId: replacement,
      status: 'failed',
      validationAttempts: 1,
      artifactsPath: withSnapshot ? `${f.root}/failed-check-report` : null,
      lastValidationResult: createFailingValidationResult(f.podId, 1),
    });
    ledger.finish(admission.id, 'nonretryable', 123);
  });
  const prior = f.recovery.list(f.podId)[0]!;
  expect(prior.checked?.result.overall).toBe('fail');
  expect(prior.blocked).toBeNull();
  const request = {
    ...f.input,
    id: 'explicit-checks-successor',
    expectedGeneration: 2,
    expectedResultHash: checkpointHash(f.pod().lastValidationResult),
    mode: 'checks' as const,
    qualification:
      'Diagnosed validation configuration failure; preserve exact prior source and resource',
    reason: 'Explicitly run new checks from the same retained source without another coding worker',
  };
  return { f, prior, request, replacement };
}
describe('one-shot quiescence after completed retained checks', () => {
  it('combines scoped owner selection with quiescence and reconstructs the selected configuration before queue dispatch', async () => {
    const { f, request } = await failedChecks();
    const launch = f.ctx.deps.launchConfiguration!;
    const parent = launch.read(f.podId)!;
    const execution = {
      profileId: 'same-qualified-software',
      parentDigest: parent.digest,
      environment: parent.environment,
      resolvedEnvironment: parent.resolvedEnvironment,
      target: parent.execution.target,
      main: parent.resolvedExecution.main,
      resolvedExecution: parent.resolvedExecution,
      digest: '',
    };
    execution.digest = retainedContinuationLaunch(parent, f.podId, execution).digest;
    f.deps.previewExecution = vi.fn(async () => execution);
    f.recovery = createRetainedCheckpointRecovery(f.deps);
    const preview = await f.recovery.previewExecution(f.podId, execution.profileId, ['XPM_BICEP']);
    const scoped = {
      ...request,
      buildOnlyEnvironmentKeys: ['XPM_BICEP'],
      executionProfileId: execution.profileId,
      expectedExecutionDigest: preview.digest,
    };
    vi.mocked(f.cm.stop).mockImplementation(async () => {
      f.cm.getStatus = vi.fn(async () => 'stopped');
    });
    await f.recovery.recoverInfrastructure(f.podId, scoped, f.actor);
    await f.recovery.wait(scoped.id);
    expect(f.recovery.list(f.podId).find((r) => r.id === scoped.id)?.activated).toEqual({
      generation: 3,
    });
    const next = launch.read(f.podId)!;
    expect(next.digest).toBe(preview.digest);
    expect(next.repository!.setup.buildEnv).toEqual({ CI: { value: 'true' } });
    expect(launch.executionSettings(next).buildEnv).toEqual({ CI: 'true' });
    expect(next.repository!.setup.buildCommand).toContain(
      "env 'XPM_BICEP=/pinned/bicep' /bin/sh -c",
    );
    expect(next.repository!.setup.testCommand).toBe(parent.repository!.setup.testCommand);
    expect(next.ai).toEqual(parent.ai);
    expect(next.workflow).toEqual(parent.workflow);
    expect(parent.repository!.setup.buildEnv.XPM_BICEP).toEqual({ value: '/pinned/bicep' });
    await f.ctx.podRepo.retainedCheckpoints!.owned(scoped.id, () =>
      f.recovery.verifySource(f.podId),
    );
    f.ctx.db.prepare('UPDATE pods SET user_id=? WHERE id=?').run('different-owner', f.podId);
    await expect(
      f.recovery.reconcileInfrastructure(f.podId, scoped, f.actor),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const dispatch = vi.fn(async () => {});
    await expect(f.recovery.process(f.podId, dispatch)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
  });
  it('acquires custody before one stop and preserves exact predecessor result, source and task accounting', async () => {
    const { f, prior, request, replacement } = await failedChecks();
    expect(f.pod().executionTarget).toBe('local');
    expect(f.ctx.deps.launchConfiguration!.read(f.podId)!.ai.reviewer.mode).toBe('independent');
    expect(f.ctx.podRepo.retainedCheckpoints!.completedChecksAdmission(f.pod())).toBe(true);
    expect(prior.taskId).toBe(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).taskId);
    expect(prior.checked!.resultHash).toBe(f.recovery.selection(f.podId).expectedResultHash);
    const task = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    vi.mocked(f.cm.stop).mockImplementation(async (id) => {
      expect(id).toBe(replacement);
      expect(
        f.recovery.list(f.podId).find((r) => r.id === request.id)?.binding.continuation
          ?.infrastructure?.predecessorChecksId,
      ).toBe(prior.id);
      f.cm.getStatus = vi.fn(async () => 'stopped');
    });
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    await f.recovery.wait(request.id);
    const next = f.recovery.list(f.podId).find((r) => r.id === request.id)!;
    expect(next.blocked).toBeNull();
    expect(next.activated).toEqual({ generation: 3 });
    expect(next.originalEvidence.result).toEqual(prior.checked!.result);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).agentRunCount).toBe(task.agentRunCount);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).recordedTotalTokens).toBe(
      task.recordedTotalTokens,
    );
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.recovery.list(f.podId).find((r) => r.id === prior.id)?.checked).toEqual(prior.checked);
  });
  it('observes an uncertain dispatched stop without repeating it', async () => {
    const { f, request } = await failedChecks();
    vi.mocked(f.cm.stop).mockRejectedValueOnce(new Error('Lost provider response'));
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    await f.recovery.wait(request.id);
    let record = f.recovery.list(f.podId).find((r) => r.id === request.id)!;
    expect(record.activated).toBeNull();
    expect(record.blocked).toBeNull();
    expect(record.infrastructure?.stopDispatched).toBe(true);
    await f.recovery.recoverInfrastructure(f.podId, request, f.actor);
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
    f.cm.getStatus = vi.fn(async () => 'stopped');
    await f.recovery.reconcileInfrastructure(f.podId, request, f.actor);
    record = f.recovery.list(f.podId).find((r) => r.id === request.id)!;
    expect(record.activated).toEqual({ generation: 3 });
    expect(f.cm.stop).toHaveBeenCalledTimes(1);
  });
  it.each([
    'no-labels',
    'wrong-recovery',
    'wrong-owner',
    'source-drift',
    'result-drift',
    'unsettled-retry',
    'coding-predecessor',
    'snapshot-drift',
  ])('refuses %s without any stop or new custody', async (fault) => {
    const { f, request } = await failedChecks(fault === 'snapshot-drift');
    if (fault === 'coding-predecessor') {
      const store = f.ctx.podRepo.retainedCoding!;
      const get = store.get;
      vi.spyOn(store, 'get').mockImplementation((id) =>
        id === f.input.id ? ({ id } as never) : get(id),
      );
    }
    if (fault === 'snapshot-drift') f.ctx.podRepo.update(f.podId, { containerId: '3'.repeat(64) });
    if (fault === 'no-labels') f.cm.getExecutionMetadata = undefined;
    if (fault === 'wrong-recovery' || fault === 'wrong-owner') {
      const old = await f.cm.getExecutionMetadata!(f.pod().containerId!);
      f.cm.getExecutionMetadata = vi.fn(async () => ({
        ...old,
        ...(fault === 'wrong-recovery'
          ? { resourceIdentity: 'other-recovery' }
          : { podId: 'other-pod' }),
      }));
    }
    if (fault === 'source-drift')
      f.worktrees.inspectSourceAdoption.mockResolvedValue({
        branch: f.pod().branch,
        commitSha: '4'.repeat(40),
        treeSha: '5'.repeat(40),
        worktreeClean: true,
      });
    if (fault === 'result-drift')
      f.ctx.podRepo.update(f.podId, {
        lastValidationResult: { ...f.pod().lastValidationResult!, timestamp: 'changed' },
      });
    if (fault === 'unsettled-retry') {
      const ledger = f.ctx.podRepo.taskRetries!;
      const previous = f.ctx.db
        .prepare('SELECT binding_hash FROM task_retry_attempts ORDER BY rowid DESC LIMIT 1')
        .get() as { binding_hash: string };
      ledger.authorize(
        f.podId,
        'fixture-pending-check',
        'Explicit fixture admission to verify pending checks are not settled',
        f.actor,
      );
      ledger.admit(
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
        [0, 0, 0, 0],
      );
    }
    await expect(f.recovery.recoverInfrastructure(f.podId, request, f.actor)).rejects.toThrow();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.recovery.list(f.podId).find((r) => r.id === request.id)).toBeUndefined();
  });
});
