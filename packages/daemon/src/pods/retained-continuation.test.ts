import { rm } from 'node:fs/promises';
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

  it.each([false, true])(
    'continues an ordinary retained custom workflow, local=%s, without a worker or budget reset',
    async (local) => {
      const f = await fixture(local);
      const before = f.pod();
      const retries = f.ctx.podRepo.taskRetries!.state(f.podId);
      const task = f.ctx.podRepo.taskExecutions!.snapshot(f.podId);
      await f.recovery.continueRetained(f.podId, f.input, f.actor);
      await f.recovery.wait(f.input.id);
      const op = f.recovery.list(f.podId)[0]!;
      expect(op.blocked, JSON.stringify(vi.mocked(f.deps.logger.error).mock.calls)).toBeNull();
      expect(op.binding.continuation).toEqual({ prepareOnly: false });
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
      expect(f.ctx.podRepo.taskExecutions!.snapshot(f.podId).agentRunCount).toBe(
        task.agentRunCount,
      );
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
    },
  );

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
