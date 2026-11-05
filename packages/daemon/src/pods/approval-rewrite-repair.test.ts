import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { repairGit, rewriteRepairFixture } from '../test-utils/approval-rewrite-repair-helpers.js';
import { createApprovalSourceRewriteRepository } from './approval-source-rewrite-repository.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import {
  checkpointHash,
  createRetainedCheckpointRepository,
} from './retained-checkpoint-repository.js';

const fixtures: Awaited<ReturnType<typeof rewriteRepairFixture>>[] = [];
async function fixture() {
  const f = await rewriteRepairFixture();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.request.id);
    f.ctx.db.close();
    await rm(f.root, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

it('prepares failed rewrite independently, selects an operator commit once and preserves both sources and lease', async () => {
  const f = await fixture();
  const before = f.pod();
  const originalRewrite = f.ctx.podRepo.approvalRewrites!.get(f.rewriteId);
  const retries = f.ctx.podRepo.taskRetries!.state(f.podId);
  await expect(
    f.recovery.continueRetained(f.podId, { ...f.input, prepareOnly: true }, f.actor),
  ).rejects.toThrow('rewrite owns');
  await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
  await f.recovery.wait(f.request.id);
  const op = f.recovery.list(f.podId)[0]!;
  expect(op.blocked, JSON.stringify(vi.mocked(f.deps.logger.error).mock.calls)).toBeNull();
  expect(op.prepared).not.toBeNull();
  expect(f.pod()).toEqual(before);
  expect(f.deps.enqueue).not.toHaveBeenCalled();
  expect(await readFile(path.join(op.prepared!.snapshot, 'ignored-report.txt'), 'utf8')).toContain(
    'Original report',
  );
  const checkout = op.prepared!.worktree;
  await writeFile(path.join(checkout, 'source.ts'), 'export const repaired = true;\n');
  await repairGit(checkout, 'add', 'source.ts');
  await repairGit(
    checkout,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'repair',
  );
  const head = await repairGit(checkout, 'rev-parse', 'HEAD');
  f.worktrees.assertSourceDescendsFrom = vi.fn(async (cwd, ancestor) => {
    await repairGit(cwd, 'merge-base', '--is-ancestor', ancestor, 'HEAD');
  });
  const input = {
    rewriteId: f.rewriteId,
    failedDispatchId: f.dispatchId,
    expectedGeneration: before.lifecycleGeneration,
    expectedResultHash: f.request.expectedResultHash,
    candidateHead: head,
    reason: 'Select the committed repair for fresh checks and independent review',
  };
  await expect(f.recovery.checkCandidate(f.podId, op.id, input, f.actor)).rejects.toThrow(
    'dedicated',
  );
  const selected = await f.recovery.checkRewriteRepair(f.podId, op.id, input, f.actor);
  expect(f.pod()).toMatchObject({
    status: 'queued',
    skipAgent: true,
    autoApprove: false,
    lifecycleGeneration: before.lifecycleGeneration + 1,
    containerId: null,
    worktreePath: checkout,
    validationAttempts: before.validationAttempts,
    maxValidationAttempts: before.maxValidationAttempts,
    launchConfigDigest: before.launchConfigDigest,
    options: before.options,
  });
  expect(f.ctx.podRepo.taskRetries!.state(f.podId)).toEqual(retries);
  expect(f.ctx.podRepo.approvalRewrites!.get(f.rewriteId)).toEqual(originalRewrite);
  expect(f.ctx.podRepo.approvalRewrites!.latest(f.pod())).toMatchObject({
    repairId: op.id,
    prepared: { head },
    binding: originalRewrite!.binding,
  });
  expect(() => f.ctx.podRepo.approvalRewrites!.assertDelivery(f.pod())).toThrow('no current');
  expect(await f.recovery.checkRewriteRepair(f.podId, op.id, input, f.actor)).toEqual(selected);
  expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
  expect(await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor)).toEqual(selected);
  await expect(
    f.recovery.checkRewriteRepair(
      f.podId,
      op.id,
      { ...input, candidateHead: f.source.commitSha },
      f.actor,
    ),
  ).rejects.toThrow('differs');
  await expect(
    f.recovery.checkRewriteRepair(f.podId, op.id, input, { type: 'human', userId: 'other' }),
  ).rejects.toThrow('actor');
  for (const cwd of [f.original, before.worktreePath!]) {
    expect(await repairGit(cwd, 'rev-parse', 'HEAD')).toBe(f.source.commitSha);
    expect(await readFile(path.join(cwd, 'ignored-report.txt'), 'utf8')).toContain(
      'Original report',
    );
  }
  const reopened = new Database(f.ctx.db.serialize());
  try {
    const restored = createApprovalSourceRewriteRepository(reopened);
    expect(restored.latest(f.pod())?.binding).toEqual(originalRewrite!.binding);
    expect(restored.latest(f.pod())?.prepared?.head).toBe(head);
    expect(
      createRetainedCheckpointRepository(reopened).get(op.id)?.originalEvidence.result,
    ).toEqual(JSON.parse(JSON.stringify(f.result)));
  } finally {
    reopened.close();
  }
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

it.each([
  'dispatch',
  'generation',
  'result',
  'actor',
  'running',
  'review',
  'local',
  'dirty',
  'unsettled',
] as const)('refuses %s before claiming repair custody', async (kind) => {
  const f = await fixture();
  const request = { ...f.request };
  if (kind === 'dispatch') request.failedDispatchId = 'foreign';
  if (kind === 'generation') request.expectedGeneration++;
  if (kind === 'result') request.expectedResultHash = checkpointHash({});
  if (kind === 'running') vi.mocked(f.cm.getStatus).mockResolvedValue('running');
  if (kind === 'local') {
    f.ctx.podRepo.update(f.podId, { containerId: null });
    f.ctx.podRepo.update(f.podId, { executionTarget: 'local' });
  }
  if (kind === 'review') {
    const settings = f.deps.executionForPod(f.pod());
    f.deps.executionForPod = () => ({ ...settings, skipValidationPhases: ['review'] });
  }
  if (kind === 'dirty') await writeFile(path.join(f.pod().worktreePath!, 'source.ts'), 'dirty');
  if (kind === 'unsettled') {
    const wakeups = f.ctx.podRepo.sandboxWakeups!;
    wakeups.observeRunning(f.resourceKey, f.containerId);
    wakeups.beginDispatch(wakeups.claim(f.resourceKey, f.containerId, f.podId).id);
  }
  const controller = createRetainedCheckpointRecovery(f.deps);
  await expect(
    controller.prepareRewriteRepair(
      f.podId,
      request,
      kind === 'actor' ? { type: 'human', userId: '' } : f.actor,
    ),
  ).rejects.toThrow();
  expect(controller.list(f.podId)).toEqual([]);
  expect(f.deps.enqueue).not.toHaveBeenCalled();
});

it.each([true, false])(
  'runs fresh checks/review only with a separate retry grant=%s, without publication or workers',
  async (grant) => {
    const f = await fixture();
    vi.stubEnv('DATA_DIR', f.root);
    const before = f.pod();
    const previous = f.ctx.podRepo.taskRetries!.state(f.podId);
    await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
    await f.recovery.wait(f.request.id);
    const op = f.recovery.list(f.podId)[0]!;
    const input = {
      rewriteId: f.rewriteId,
      failedDispatchId: f.dispatchId,
      expectedGeneration: before.lifecycleGeneration,
      expectedResultHash: f.request.expectedResultHash,
      candidateHead: op.prepared!.head,
      reason: 'Check exactly the independently prepared source with frozen authority',
    };
    await f.recovery.checkRewriteRepair(f.podId, op.id, input, f.actor);
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation()!;
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => ({
      ...(await validate(config)),
      taskReview: {
        status: 'pass',
        reasoning: 'Independent review fixture',
        issues: [],
        model: 'fixture',
        screenshots: [],
      },
    }));
    if (grant)
      f.ctx.podRepo.taskRetries!.authorize(
        f.podId,
        'separate-repair-retry',
        'One explicit retry for this selected failed rewrite repair',
        f.actor,
      );
    if (grant) await f.manager.processPod(f.podId);
    else await expect(f.manager.processPod(f.podId)).rejects.toThrow('did not produce a result');
    const current = f.pod();
    const completed = f.recovery.list(f.podId)[0]!;
    if (grant) {
      expect(current.status, current.failureReason ?? JSON.stringify(completed)).toBe('validated');
      expect(completed.checked?.result.overall, JSON.stringify(completed.blocked)).toBe('pass');
      expect(completed.checked?.result.taskReview?.status).toBe('pass');
      expect(completed.checked?.snapshot?.path).toBe(current.artifactsPath);
      expect(f.ctx.podRepo.approvalRewrites!.assertDelivery(current)?.checked?.validationHash).toBe(
        checkpointHash(current.lastValidationResult),
      );
      expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
      expect(f.ctx.podRepo.taskRetries!.state(f.podId).executedCount).toBe(
        previous.executedCount + 1,
      );
    } else {
      expect(current.status).toBe('review_required');
      expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
      expect(f.ctx.podRepo.taskRetries!.state(f.podId).executedCount).toBe(previous.executedCount);
      expect(() => f.ctx.podRepo.approvalRewrites!.assertDelivery(current)).toThrow();
    }
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    await expect(f.manager.triggerValidation(f.podId, { force: true })).rejects.toThrow();
    if (grant) await f.manager.processPod(f.podId);
    else await expect(f.manager.processPod(f.podId)).rejects.toThrow();
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(grant ? 1 : 0);
  },
);

it.each([
  'dirty',
  'branch',
  'unrelated',
  'grafts',
  'alternates',
  'remote',
  'filter',
  'alias',
] as const)('rejects tampered prepared candidate: %s', async (kind) => {
  const f = await fixture();
  await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
  await f.recovery.wait(f.request.id);
  const op = f.recovery.list(f.podId)[0]!;
  const prepared = op.prepared!;
  if (kind === 'dirty') await writeFile(path.join(prepared.worktree, 'source.ts'), 'dirty');
  if (kind === 'branch') await repairGit(prepared.worktree, 'checkout', '-b', 'other');
  if (kind === 'unrelated') {
    await repairGit(prepared.worktree, 'checkout', '--orphan', 'orphan');
    await repairGit(
      prepared.worktree,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'unrelated',
    );
    await repairGit(prepared.worktree, 'branch', '-M', f.pod().branch);
  }
  if (kind === 'grafts')
    await writeFile(path.join(prepared.bare, 'info', 'grafts'), `${prepared.head}\n`);
  if (kind === 'alternates')
    await writeFile(
      path.join(prepared.bare, 'objects', 'info', 'alternates'),
      '/tmp/foreign-objects\n',
    );
  if (kind === 'remote')
    await repairGit(
      prepared.worktree,
      'remote',
      'set-url',
      'origin',
      'https://github.com/foreign/repository',
    );
  if (kind === 'filter') await repairGit(prepared.worktree, 'config', 'filter.bad.clean', 'false');
  if (kind === 'alias') {
    const { rename, symlink } = await import('node:fs/promises');
    await rename(prepared.worktree, `${prepared.worktree}-other`);
    await symlink(`${prepared.worktree}-other`, prepared.worktree);
  }
  const head =
    kind === 'unrelated' ? await repairGit(prepared.worktree, 'rev-parse', 'HEAD') : prepared.head;
  await expect(
    f.recovery.checkRewriteRepair(
      f.podId,
      op.id,
      {
        rewriteId: f.rewriteId,
        failedDispatchId: f.dispatchId,
        expectedGeneration: f.request.expectedGeneration,
        expectedResultHash: f.request.expectedResultHash,
        candidateHead: head,
        reason: 'Select committed repair source without expanding task authority',
      },
      f.actor,
    ),
  ).rejects.toThrow();
  expect(f.recovery.list(f.podId)[0]!.activated).toBeNull();
  expect(f.deps.enqueue).not.toHaveBeenCalled();
});

it('retains crashed preparation as a non-replayable claim across database reopen', async () => {
  const f = await fixture();
  f.deps.prepare = async () => {
    throw new Error('preparation transport lost');
  };
  const controller = createRetainedCheckpointRecovery(f.deps);
  await controller.prepareRewriteRepair(f.podId, f.request, f.actor);
  await controller.wait(f.request.id);
  const record = controller.list(f.podId)[0]!;
  expect(record).toMatchObject({
    prepared: null,
    activated: null,
    blocked: { code: 'CHECKPOINT_PREPARATION_FAILED' },
  });
  const reopened = new Database(f.ctx.db.serialize());
  try {
    expect(createRetainedCheckpointRepository(reopened).get(record.id)).toEqual(record);
  } finally {
    reopened.close();
  }
  const next = createRetainedCheckpointRecovery(f.deps);
  expect(await next.prepareRewriteRepair(f.podId, f.request, f.actor)).toEqual(record);
  await expect(
    next.prepareRewriteRepair(f.podId, { ...f.request, id: 'replacement-id' }, f.actor),
  ).rejects.toThrow();
  expect(f.deps.enqueue).not.toHaveBeenCalled();
});
