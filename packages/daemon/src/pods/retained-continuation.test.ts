import { rm } from 'node:fs/promises';
import Database from 'better-sqlite3';
import type Dockerode from 'dockerode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { retainedCheckpointFixture } from '../test-utils/retained-checkpoint-helpers.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import {
  assertCheckpointResourceNotRetained,
  checkpointHash,
  createRetainedCheckpointRepository,
} from './retained-checkpoint-repository.js';

const fixtures: Awaited<ReturnType<typeof retainedCheckpointFixture>>[] = [];
async function fixture(local = false) {
  const f = await retainedCheckpointFixture('validation');
  fixtures.push(f);
  const result = { ...f.result, infrastructureFailure: undefined };
  if (local) {
    f.ctx.podRepo.update(f.podId, { containerId: null });
    f.ctx.podRepo.update(f.podId, { executionTarget: 'local' });
  }
  f.ctx.podRepo.update(f.podId, {
    lastValidationResult: result,
    ...(local ? { executionTarget: 'local' as const, containerId: 'f'.repeat(64) } : {}),
  });
  f.input.expectedResultHash = checkpointHash(result);
  f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => ({
    head: input.remoteHead ?? f.prepared.head,
    tree: f.prepared.tree,
    baseCommitSha: '1'.repeat(40),
  }));
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    if (f.ctx.db.open) f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('explicit retention-safe continuation', () => {
  it('guards retired Docker originals at the backend boundary, even after pointer changes and reopening', async () => {
    const f = await fixture(true);
    const id = f.pod().containerId!;
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    const getContainer = vi.fn();
    const manager = new DockerContainerManager({
      docker: { getContainer } as unknown as Dockerode,
      logger: f.ctx.deps.logger,
      managedDatabase: f.ctx.db,
    });
    for (const action of [
      () => manager.start(id),
      () => manager.stop(id),
      () => manager.kill(id),
      () => manager.execInContainer(id, ['true']),
      () => manager.execStreaming(id, ['true']),
      () => manager.writeFile(id, '/tmp/unsafe', 'bytes'),
      () => manager.readFileBinary(id, '/workspace/report'),
      () => manager.extractDirectoryFromContainer(id, '/workspace', '/tmp/unsafe'),
    ])
      await expect(action()).rejects.toMatchObject({ code: 'CHECKPOINT_ORIGINAL_RETAINED' });
    expect(getContainer).not.toHaveBeenCalled();
    expect(createRetainedCheckpointRepository(f.ctx.db).get(f.input.id)?.containerId).toBe(id);
  });

  it.each([
    false,
    true,
  ])('continues an ordinary retained custom workflow, local=%s, without a worker or budget reset', async (local) => {
    const f = await fixture(local);
    const before = f.pod();
    const retries = f.ctx.podRepo.taskRetries!.state(f.podId);
    const task = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    const op = f.recovery.list(f.podId)[0]!;
    expect(op.blocked, JSON.stringify(vi.mocked(f.deps.logger.error).mock.calls)).toBeNull();
    expect(op.binding.continuation).toEqual({ prepareOnly: false, reviewPolicy: 'independent-v1' });
    expect(op.containerId).toBe(before.containerId);
    expect(f.pod()).toMatchObject({
      status: 'queued',
      skipAgent: true,
      autoApprove: false,
      validationAttempts: before.validationAttempts,
      maxValidationAttempts: before.maxValidationAttempts,
      containerId: null,
      options: before.options,
    });
    expect(f.ctx.podRepo.taskRetries!.state(f.podId)).toEqual(retries);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).taskId).toBe(task.taskId);
    expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).agentRunCount).toBe(task.agentRunCount);
    expect(() => assertCheckpointResourceNotRetained(f.ctx.db, op.containerId)).toThrow(
      'retains source/report',
    );
    for (const method of [
      f.cm.start,
      f.cm.stop,
      f.cm.kill,
      f.cm.spawn,
      f.cm.execInContainer,
      f.cm.extractDirectoryFromContainer,
    ])
      expect(method).not.toHaveBeenCalled();
  });

  it('keeps legacy checkpoint admission unchanged for an ordinary settled task', async () => {
    const f = await fixture();
    await expect(f.submit()).rejects.toThrow('Use ordinary checks/approval');
    expect(f.recovery.list(f.podId)).toEqual([]);
  });

  it('prepares repair source without activation and accepts only one exact human-selected descendant', async () => {
    const f = await fixture();
    const before = f.pod();
    await f.recovery.continueRetained(f.podId, { ...f.input, prepareOnly: true }, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.pod()).toEqual(before);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      prepared: f.prepared,
      activated: null,
      selected: null,
    });
    const candidate = 'e'.repeat(40);
    f.worktrees.inspectSourceAdoption.mockResolvedValue({
      branch: before.branch,
      commitSha: candidate,
      treeSha: 'd'.repeat(40),
      worktreeClean: true,
    });
    f.worktrees.assertSourceDescendsFrom = vi.fn(async () => {});
    const input = {
      expectedGeneration: before.lifecycleGeneration,
      expectedResultHash: f.input.expectedResultHash,
      candidateHead: candidate,
      reason:
        'Select the reviewed committed repair candidate for fresh checks, retaining original work',
    };
    const record = await f.recovery.checkCandidate(f.podId, f.input.id, input, f.actor);
    expect(record.selected).toMatchObject({
      head: candidate,
      tree: 'd'.repeat(40),
      actor: f.actor,
    });
    expect(f.worktrees.assertSourceDescendsFrom).toHaveBeenCalledWith(
      f.prepared.worktree,
      f.prepared.head,
    );
    expect(f.pod()).toMatchObject({
      status: 'queued',
      lifecycleGeneration: before.lifecycleGeneration + 1,
      skipAgent: true,
      validationAttempts: before.validationAttempts,
    });
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    expect(await f.recovery.checkCandidate(f.podId, f.input.id, input, f.actor)).toEqual(record);
    await expect(
      f.recovery.checkCandidate(
        f.podId,
        f.input.id,
        { ...input, candidateHead: 'f'.repeat(40) },
        f.actor,
      ),
    ).rejects.toThrow('differs');
    const reopened = createRetainedCheckpointRepository(f.ctx.db);
    expect(reopened.get(f.input.id)?.selected).toEqual(record.selected);
    expect(() => f.ctx.db.prepare('DELETE FROM retained_continuation_sources').run()).toThrow(
      'cannot be deleted',
    );
  });

  it('pins a human Docker test allowance and uses the existing started admission as its one-shot receipt', async () => {
    const f = await fixture(true);
    const profile = f.deps.executionForPod(f.pod());
    f.deps.executionForPod = () => ({ ...profile, testTimeout: 900 });
    await f.recovery.continueRetained(f.podId, { ...f.input, prepareOnly: true }, f.actor);
    await f.recovery.wait(f.input.id);
    const input = {
      expectedGeneration: f.input.expectedGeneration,
      expectedResultHash: f.input.expectedResultHash,
      candidateHead: f.prepared.head,
      reason: 'Select this exact retained source for one independent check',
      testBudget: {
        seconds: 1800,
        reason: 'Measured full suite exceeded the frozen fifteen minute outer limit',
      },
    };
    const before = f.pod();
    const selected = await f.recovery.checkCandidate(f.podId, f.input.id, input, f.actor);
    expect(selected.selected?.testBudget).toEqual({
      ...input.testBudget,
      frozenTimeoutSeconds: 900,
    });
    expect(f.pod().validationAttempts).toBe(before.validationAttempts);
    expect(f.ctx.podRepo.taskRetries!.state(f.podId).authorizations).toEqual([]);
    const repo = f.ctx.podRepo.retainedCheckpoints!;
    expect(() => repo.testBudget(f.pod(), 900000)).toThrow();
    await f.recovery.process(f.podId, async () => {
      for (const status of ['provisioning', 'running', 'validating'] as const)
        f.deps.transition(f.pod(), status);
      f.ctx.podRepo.update(f.podId, { containerId: 'replacement' });
      expect(() => repo.testBudget(f.pod(), 600000)).toThrow('frozen timeout');
      expect(repo.testBudget(f.pod(), 900000)).toMatchObject({ seconds: 1800, used: false });
      for (const drift of [
        { lifecycleGeneration: f.pod().lifecycleGeneration + 1 },
        { worktreePath: '/other' },
        { containerId: selected.containerId },
        { executionTarget: 'sandbox' as const },
      ])
        expect(() => repo.testBudget({ ...f.pod(), ...drift }, 900000)).toThrow();
      const ledger = f.ctx.podRepo.taskRetries!;
      ledger.authorize(
        f.podId,
        'separate-budget-fixture-retry',
        'One explicit retry, separate from the finite outer-test allowance',
        f.actor,
      );
      const prior = f.ctx.db
        .prepare(
          'SELECT binding_hash AS hash FROM task_retry_attempts WHERE pod_id=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(f.podId) as { hash: string };
      const admission = ledger.admit(
        f.podId,
        f.pod().lifecycleGeneration,
        {
          source: 'a'.repeat(64),
          contract: 'b'.repeat(64),
          commands: 'c'.repeat(64),
          environment: null,
          implementation: null,
        },
        prior.hash,
        [],
      );
      ledger.start(admission.id);
      expect(repo.testBudget(f.pod(), 900000)?.used).toBe(true);
      expect(createRetainedCheckpointRepository(f.ctx.db).testBudget(f.pod(), 900000)?.used).toBe(
        true,
      );
      const reopenedDb = new Database(f.ctx.db.serialize());
      try {
        const reopened = createRetainedCheckpointRepository(reopenedDb);
        expect(() => reopened.testBudget(f.pod(), 900000)).toThrow();
        expect(reopened.owned(f.input.id, () => reopened.testBudget(f.pod(), 900000))?.used).toBe(
          true,
        );
      } finally {
        reopenedDb.close();
      }
      ledger.finish(admission.id, 'nonretryable', 10);
      f.ctx.podRepo.update(f.podId, {
        lastValidationResult: { ...f.result, overall: 'fail', infrastructureFailure: undefined },
      });
      f.deps.transition(f.pod(), 'review_required');
    });
    expect(() => repo.testBudget(f.pod(), 900000)).toThrow();
    expect(
      repo.testBudget({ ...f.pod(), lifecycleGeneration: f.pod().lifecycleGeneration + 1 }, 900000),
    ).toBeNull();
    expect((await f.recovery.checkCandidate(f.podId, f.input.id, input, f.actor)).selected).toEqual(
      selected.selected,
    );
    await expect(
      f.recovery.checkCandidate(
        f.podId,
        f.input.id,
        {
          ...input,
          testBudget: { ...input.testBudget, seconds: 2000 },
        },
        f.actor,
      ),
    ).rejects.toThrow('differs');
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    0,
    -1,
    1.5,
    3601,
    Number.POSITIVE_INFINITY,
    900,
  ])('rejects invalid/non-extending test allowance %s before activation', async (seconds) => {
    const f = await fixture(true);
    const profile = f.deps.executionForPod(f.pod());
    f.deps.executionForPod = () => ({ ...profile, testTimeout: 900 });
    await f.recovery.continueRetained(f.podId, { ...f.input, prepareOnly: true }, f.actor);
    await f.recovery.wait(f.input.id);
    await expect(
      f.recovery.checkCandidate(
        f.podId,
        f.input.id,
        {
          expectedGeneration: f.input.expectedGeneration,
          expectedResultHash: f.input.expectedResultHash,
          candidateHead: f.prepared.head,
          reason: 'Select exact source for independent validation',
          testBudget: {
            seconds,
            reason: 'Finite one-shot test allowance with no workflow edits',
          },
        },
        f.actor,
      ),
    ).rejects.toThrow();
    expect(f.recovery.list(f.podId)[0]?.selected).toBeNull();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('does not extend sandbox budgets through the Docker-only candidate path', async () => {
    const f = await fixture();
    await f.recovery.continueRetained(f.podId, { ...f.input, prepareOnly: true }, f.actor);
    await f.recovery.wait(f.input.id);
    await expect(
      f.recovery.checkCandidate(
        f.podId,
        f.input.id,
        {
          expectedGeneration: f.input.expectedGeneration,
          expectedResultHash: f.input.expectedResultHash,
          candidateHead: f.prepared.head,
          reason: 'Select exact source for independent validation',
          testBudget: { seconds: 1800, reason: 'Finite one-shot allowance with a separate reason' },
        },
        f.actor,
      ),
    ).rejects.toThrow('Docker');
  });

  it('selects divergent remote source only after preservation, without modifying the original', async () => {
    const f = await fixture();
    const original = f.pod().worktreePath;
    const remote = 'e'.repeat(40);
    f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
      expect(f.deps.prepare).toHaveBeenCalledTimes(1);
      expect(input).toMatchObject({
        originalWorktreePath: original,
        worktreePath: f.prepared.worktree,
        head: f.prepared.head,
        remoteHead: remote,
      });
      return { head: remote, tree: 'f'.repeat(40), baseCommitSha: '1'.repeat(40) };
    });
    await f.recovery.continueRetained(f.podId, { ...f.input, remoteHead: remote }, f.actor);
    await f.recovery.wait(f.input.id);
    const op = f.recovery.list(f.podId)[0]!;
    expect(op.blocked).toBeNull();
    expect(op.binding.head).toBe(f.prepared.head);
    expect(op.worktreePath).toBe(original);
    expect(op.prepared).toMatchObject({ head: remote, tree: 'f'.repeat(40) });
    expect(f.cm.start).not.toHaveBeenCalled();
  });

  it('retains the claim after uncertain remote selection; repeats observe and do not fetch again', async () => {
    const f = await fixture();
    f.worktrees.selectRetainedContinuationSource = vi.fn(async () => {
      throw new Error('lost response');
    });
    const input = { ...f.input, remoteHead: 'e'.repeat(40) };
    await f.recovery.continueRetained(f.podId, input, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      activated: null,
      blocked: { code: 'CHECKPOINT_PREPARATION_FAILED' },
    });
    const resumed = createRetainedCheckpointRecovery(f.deps);
    await resumed.continueRetained(f.podId, input, f.actor);
    expect(f.worktrees.selectRetainedContinuationSource).toHaveBeenCalledTimes(1);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    'review',
    'waiver',
    'running',
    'decision',
    'worker',
    'stale',
    'artifact',
    'sidecars',
  ] as const)('refuses %s without claiming resources', async (kind) => {
    const f = await fixture();
    if (kind === 'artifact')
      f.ctx.podRepo.update(f.podId, { options: { ...f.pod().options, output: 'artifact' } });
    if (kind === 'sidecars') f.ctx.podRepo.update(f.podId, { requireSidecars: ['postgres'] });
    if (kind === 'review')
      f.deps.executionForPod = () => ({
        ...f.ctx.profileStore.get('test-profile'),
        skipValidationPhases: ['review'],
      });
    if (kind === 'waiver') f.ctx.podRepo.update(f.podId, { skipValidation: true });
    if (kind === 'running') vi.mocked(f.cm.getStatus).mockResolvedValue('running');
    if (kind === 'decision')
      f.ctx.podRepo.update(f.podId, {
        pendingEscalation: {
          id: 'decision',
          type: 'ask_human',
          payload: {},
          createdAt: new Date().toISOString(),
        } as never,
      });
    if (kind === 'worker') f.deps.isIdle = () => false;
    if (kind === 'stale') f.input.expectedGeneration++;
    const recovery = createRetainedCheckpointRecovery(f.deps);
    await expect(recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toThrow();
    expect(recovery.list(f.podId)).toEqual([]);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });
});
