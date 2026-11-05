import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/connection.js';
import { repairGit, rewriteRepairFixture } from '../test-utils/approval-rewrite-repair-helpers.js';
import { LocalWorktreeManager } from '../worktrees/local-worktree-manager.js';
import { createApprovalSourceRewriteRepository } from './approval-source-rewrite-repository.js';
import { createPodManager } from './pod-manager.js';
import { createRetainedCheckpointRecovery } from './retained-checkpoint-recovery.js';
import {
  checkpointHash,
  createRetainedCheckpointRepository,
} from './retained-checkpoint-repository.js';
import { assertSourceDeliveryAllowed } from './source-custody-guards.js';

const fixtures: Awaited<ReturnType<typeof rewriteRepairFixture>>[] = [];
async function fixture() {
  const f = await rewriteRepairFixture();
  fixtures.push(f);
  return f;
}
function authorizeRepairCheck(
  f: Awaited<ReturnType<typeof rewriteRepairFixture>>,
  op: NonNullable<ReturnType<typeof f.recovery.list>[number]>,
  key: string,
  head = op.prepared!.head,
  tree = op.prepared!.tree,
) {
  return f.ctx.podRepo.taskRetries!.authorize(
    f.podId,
    key,
    'Separate permission for exactly this prepared rewrite repair candidate',
    f.actor,
    undefined,
    { recoveryId: op.id, candidateHead: head, candidateTree: tree },
  );
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
  const dbPath = path.join(f.root, 'reopen.db');
  await f.ctx.db.backup(dbPath);
  const reopened = createDatabase(dbPath, f.ctx.deps.logger);
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
}, 15_000);

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
    f.ctx.podRepo.update(f.podId, { maxValidationAttempts: f.pod().validationAttempts });
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
    const permission = grant ? authorizeRepairCheck(f, op, 'separate-repair-retry') : null;
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
      const used = f.ctx.podRepo
        .taskRetries!.state(f.podId)
        .authorizations.find((item) => item.id === permission!.id)!;
      expect(used.usedByAttemptId).toBeTruthy();
      expect(used.rewriteRepair).toMatchObject({
        recoveryId: op.id,
        generation: current.lifecycleGeneration,
        candidateHead: completed.selected!.head,
        candidateTree: completed.selected!.tree,
      });
      expect(current.lastValidationResult!.executionDispatchId).not.toBe(f.dispatchId);
      expect(() =>
        f.ctx.db
          .prepare('DELETE FROM task_retry_authorization_uses WHERE authorization_id=?')
          .run(used.id),
      ).toThrow('retained');
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
  15_000,
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
  const dbPath = path.join(f.root, 'reopen.db');
  await f.ctx.db.backup(dbPath);
  const reopened = createDatabase(dbPath, f.ctx.deps.logger);
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

it('retains atomic selection after enqueue loss and never enqueues accepted selection twice', async () => {
  const f = await fixture();
  await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
  await f.recovery.wait(f.request.id);
  const op = f.recovery.list(f.podId)[0]!;
  vi.mocked(f.deps.enqueue).mockImplementation(() => {
    throw new Error('enqueue interruption');
  });
  const input = {
    rewriteId: f.rewriteId,
    failedDispatchId: f.dispatchId,
    expectedGeneration: f.request.expectedGeneration,
    expectedResultHash: f.request.expectedResultHash,
    candidateHead: op.prepared!.head,
    reason: 'Select the exact prepared candidate for one checks invocation',
  };
  await expect(f.recovery.checkRewriteRepair(f.podId, op.id, input, f.actor)).rejects.toThrow(
    'enqueue interruption',
  );
  const accepted = f.recovery.list(f.podId)[0]!;
  expect(accepted.activated?.generation).toBe(f.pod().lifecycleGeneration);
  expect(f.pod().status).toBe('queued');
  const resumed = createRetainedCheckpointRecovery(f.deps);
  expect(await resumed.checkRewriteRepair(f.podId, op.id, input, f.actor)).toEqual(accepted);
  expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
  const run = vi.fn(async () => {});
  await expect(resumed.process(f.podId, run)).rejects.toThrow('did not produce a result');
  const restarted = createRetainedCheckpointRecovery(f.deps);
  await expect(restarted.process(f.podId, run)).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
  expect(f.recovery.list(f.podId)[0]).toMatchObject({
    checking: { generation: accepted.activated!.generation },
    blocked: { code: 'CHECKPOINT_CHECKS_UNVERIFIED' },
  });
}, 15_000);

it('holds a completion crash after fresh result/report capture instead of certifying or replaying it', async () => {
  const f = await fixture();
  vi.stubEnv('DATA_DIR', f.root);
  await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
  await f.recovery.wait(f.request.id);
  const op = f.recovery.list(f.podId)[0]!;
  authorizeRepairCheck(f, op, 'completion-crash-check');
  await f.recovery.checkRewriteRepair(
    f.podId,
    op.id,
    {
      rewriteId: f.rewriteId,
      failedDispatchId: f.dispatchId,
      expectedGeneration: f.request.expectedGeneration,
      expectedResultHash: f.request.expectedResultHash,
      candidateHead: op.prepared!.head,
      reason: 'Select independent source for fresh configured checks and review',
    },
    f.actor,
  );
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
  const repository = f.ctx.podRepo.retainedCheckpoints!;
  const append = repository.append;
  vi.spyOn(repository, 'append').mockImplementation((id, kind, evidence) => {
    if (kind === 'checked') throw new Error('completion commit interrupted');
    append(id, kind, evidence);
  });
  await expect(f.manager.processPod(f.podId)).rejects.toThrow('completion commit interrupted');
  expect(f.pod().lastValidationResult?.overall).toBe('pass');
  expect(f.pod().artifactsPath).toBeTruthy();
  expect(f.recovery.list(f.podId)[0]).toMatchObject({
    checked: null,
    blocked: { code: 'CHECKPOINT_CHECKS_UNVERIFIED' },
  });
  expect(() => f.ctx.podRepo.approvalRewrites!.assertDelivery(f.pod())).toThrow();
  await expect(
    createRetainedCheckpointRecovery(f.deps).process(f.podId, async () => {}),
  ).rejects.toThrow();
  expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
}, 15_000);

it.each([false, true])(
  'delivers only the checked current candidate under fresh human approval and original Git lease; drift=%s',
  async (drift) => {
    const f = await fixture();
    vi.stubEnv('DATA_DIR', f.root);
    const originalRewrite = f.ctx.podRepo.approvalRewrites!.get(f.rewriteId)!;
    await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
    await f.recovery.wait(f.request.id);
    const op = f.recovery.list(f.podId)[0]!;
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
    const tree = await repairGit(checkout, 'rev-parse', 'HEAD^{tree}');
    authorizeRepairCheck(f, op, 'delivery-check', head, tree);
    await f.recovery.checkRewriteRepair(
      f.podId,
      op.id,
      {
        rewriteId: f.rewriteId,
        failedDispatchId: f.dispatchId,
        expectedGeneration: f.request.expectedGeneration,
        expectedResultHash: f.request.expectedResultHash,
        candidateHead: head,
        reason: 'Select targeted committed repair for fresh checks and review',
      },
      f.actor,
    );
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
    await f.manager.processPod(f.podId);
    const checkedHead = f.ctx.podRepo.approvalRewrites!.latest(f.pod())!.checked!.head;
    expect(await repairGit(checkout, 'rev-parse', 'HEAD')).toBe(checkedHead);
    const remote = path.join(f.root, 'fixture-remote.git');
    await repairGit(f.root, 'init', '--bare', remote);
    await repairGit(f.original, 'push', remote, `HEAD:refs/heads/${f.pod().branch}`);
    if (drift) {
      await writeFile(path.join(f.original, 'external.txt'), 'external advance\n');
      await repairGit(f.original, 'add', 'external.txt');
      await repairGit(
        f.original,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'external advance',
      );
      await repairGit(f.original, 'push', remote, `HEAD:refs/heads/${f.pod().branch}`);
    }
    const beforeRemote = await repairGit(remote, 'rev-parse', `refs/heads/${f.pod().branch}`);
    const real = new LocalWorktreeManager({ logger: f.ctx.deps.logger });
    (
      real as unknown as { getAuthenticatedRemote(): Promise<{ url: string }> }
    ).getAuthenticatedRemote = async () => ({ url: remote });
    const repository = originalRewrite.binding.predecessor.repository;
    // Substitute ONLY fixture provider transport. Native Git executes observation
    // and exact lease push against a disposable local remote, never a real PR.
    f.worktrees.pushBranch = vi.fn(async (cwd, branch, options) => {
      const result = await real.pushBranch(cwd, branch, {
        ...options,
        onPrepared: (source) => options?.onPrepared?.({ ...source, repository }),
      });
      return { ...result, repository };
    });
    f.worktrees.inspectSource = f.worktrees.inspectSourceAdoption;
    const provider = {
      createPr: vi.fn(async () => ({ url: f.pod().prUrl!, usedFallback: false })),
      mergePr: vi.fn(async () => ({ merged: false, autoMergeScheduled: false })),
      getPrStatus: vi.fn(async () => ({
        merged: false,
        open: true,
        blockReason: 'Waiting',
        ciFailures: [],
        reviewComments: [],
        headSha: await repairGit(remote, 'rev-parse', `refs/heads/${f.pod().branch}`),
        sourceTarget: { repository, branch: f.pod().branch, baseBranch: 'main' },
      })),
    };
    const approval = createPodManager({ ...f.ctx.deps, prManagerFactory: () => provider });
    await expect(approval.approveSession(f.podId, { automation: true })).rejects.toThrow();
    expect(f.worktrees.pushBranch).not.toHaveBeenCalled();
    const approve = () =>
      approval.approveSession(f.podId, {
        publishOnly: true,
        actor: f.actor,
        reason: 'Fresh human approval to publish exactly this checked repair for PR review only',
      });
    if (drift) {
      await expect(approve()).rejects.toThrow();
      expect(await repairGit(remote, 'rev-parse', `refs/heads/${f.pod().branch}`)).toBe(
        beforeRemote,
      );
    } else {
      await approve();
      expect(await repairGit(remote, 'rev-parse', `refs/heads/${f.pod().branch}`)).toBe(
        checkedHead,
      );
    }
    expect(f.worktrees.pushBranch).toHaveBeenCalledWith(
      checkout,
      f.pod().branch,
      expect.objectContaining({
        force: true,
        expectedRemoteCommitSha: originalRewrite.binding.predecessor.commitSha,
      }),
    );
    expect(f.pod().status).toBe('validated');
    expect(provider.mergePr).not.toHaveBeenCalled();
    expect(f.ctx.podRepo.approvalRewrites!.get(f.rewriteId)).toEqual(originalRewrite);
    if (!drift) {
      // Advance main in a third fixture checkout. Ordinary later approval must
      // isolate/recheck this new base, never relabel the old repair pass.
      const seed = path.join(f.root, 'new-main');
      await repairGit(f.root, 'clone', '--no-checkout', remote, seed);
      await repairGit(
        seed,
        'checkout',
        '-b',
        'main',
        originalRewrite.binding.predecessor.commitSha,
      );
      await writeFile(path.join(seed, 'main.txt'), 'new main base\n');
      await repairGit(seed, 'add', 'main.txt');
      await repairGit(
        seed,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'advance main',
      );
      const newBase = await repairGit(seed, 'rev-parse', 'HEAD');
      await repairGit(seed, 'push', remote, 'HEAD:refs/heads/main');
      f.worktrees.prepareApprovalRebase = real.prepareApprovalRebase.bind(real);
      await approval.approveSession(f.podId, {
        actor: f.actor,
        reason: 'Fresh approval must independently recheck the newly advanced main base',
      });
      expect(f.pod().status).toBe('queued');
      const next = f.ctx.podRepo.approvalRewrites!.latest(f.pod())!;
      expect(next.id).not.toBe(f.rewriteId);
      expect(next.binding.baseCommitSha).toBe(newBase);
      expect(next.binding.predecessor.commitSha).toBe(checkedHead);
      expect(next.checked).toBeUndefined();
      const pushes = vi.mocked(f.worktrees.pushBranch).mock.calls.length;
      vi.mocked(f.cm.spawn).mockResolvedValueOnce('33333333-3333-4333-8333-333333333333');
      await approval.processPod(f.podId);
      expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
      expect(f.ctx.podRepo.approvalRewrites!.latest(f.pod())?.checked).toBeDefined();
      expect(() => assertSourceDeliveryAllowed(f.ctx.db, f.podId)).not.toThrow();
      expect(f.worktrees.pushBranch).toHaveBeenCalledTimes(pushes);
      expect(provider.mergePr).not.toHaveBeenCalled();
      expect(await repairGit(checkout, 'rev-parse', 'HEAD')).toBe(checkedHead);
      expect(f.ctx.podRepo.approvalRewrites!.get(f.rewriteId)).toEqual(originalRewrite);
    }
  },
  15_000,
);

it('reobserves source after asynchronous candidate inspection and leaves a changed checkout unselected', async () => {
  const f = await fixture();
  await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
  await f.recovery.wait(f.request.id);
  const op = f.recovery.list(f.podId)[0]!;
  const inspect = f.worktrees.inspectSourceAdoption.getMockImplementation()!;
  let changed = false;
  f.worktrees.inspectSourceAdoption.mockImplementation(async (cwd, branch) => {
    const source = await inspect(cwd, branch);
    if (cwd === op.prepared!.worktree && !changed) {
      changed = true;
      await writeFile(path.join(cwd, 'source.ts'), 'concurrent edit\n');
    }
    return source;
  });
  await expect(
    f.recovery.checkRewriteRepair(
      f.podId,
      op.id,
      {
        rewriteId: f.rewriteId,
        failedDispatchId: f.dispatchId,
        expectedGeneration: f.request.expectedGeneration,
        expectedResultHash: f.request.expectedResultHash,
        candidateHead: op.prepared!.head,
        reason: 'Select exact source only while all observations remain current',
      },
      f.actor,
    ),
  ).rejects.toThrow();
  expect(f.recovery.list(f.podId)[0]!.selected).toBeNull();
  expect(f.deps.enqueue).not.toHaveBeenCalled();
});

it.each(['generic', 'other-source'] as const)(
  'does not consume %s retry permission for a repair selection',
  async (kind) => {
    const f = await fixture();
    vi.stubEnv('DATA_DIR', f.root);
    await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
    await f.recovery.wait(f.request.id);
    const op = f.recovery.list(f.podId)[0]!;
    const permission =
      kind === 'generic'
        ? f.ctx.podRepo.taskRetries!.authorize(
            f.podId,
            'generic-permission',
            'Generic retry does not authorize a rewrite repair source',
            f.actor,
          )
        : authorizeRepairCheck(f, op, 'other-source-permission', 'f'.repeat(40), op.prepared!.tree);
    await f.recovery.checkRewriteRepair(
      f.podId,
      op.id,
      {
        rewriteId: f.rewriteId,
        failedDispatchId: f.dispatchId,
        expectedGeneration: f.request.expectedGeneration,
        expectedResultHash: f.request.expectedResultHash,
        candidateHead: op.prepared!.head,
        reason: 'Select an exact candidate without implicitly borrowing another grant',
      },
      f.actor,
    );
    await expect(f.manager.processPod(f.podId)).rejects.toThrow('did not produce a result');
    expect(f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(
      f.ctx.podRepo
        .taskRetries!.state(f.podId)
        .authorizations.find((item) => item.id === permission.id)?.usedByAttemptId,
    ).toBeNull();
  },
  15_000,
);

it('retains an exact repair retry target on reopen, refuses changed-key replay and cannot borrow it for another selection', async () => {
  const f = await fixture();
  await f.recovery.prepareRewriteRepair(f.podId, f.request, f.actor);
  await f.recovery.wait(f.request.id);
  const op = f.recovery.list(f.podId)[0]!;
  const grant = authorizeRepairCheck(f, op, 'stable-repair-permission');
  expect(grant.rewriteRepair).toMatchObject({
    recoveryId: op.id,
    candidateHead: op.prepared!.head,
    candidateTree: op.prepared!.tree,
    generation: f.pod().lifecycleGeneration + 1,
    configurationHash: op.binding.configurationHash,
  });
  expect(authorizeRepairCheck(f, op, 'stable-repair-permission')).toEqual(grant);
  expect(() =>
    f.ctx.db.prepare('DELETE FROM task_retry_authorizations WHERE id=?').run(grant.id),
  ).toThrow('retained');
  const failure = f.ctx.podRepo.taskRetries!.state(f.podId).latest!;
  expect(() =>
    f.ctx.db
      .prepare('INSERT INTO task_retry_authorization_uses VALUES(?,?)')
      .run(grant.id, failure.id),
  ).toThrow('selection mismatch');
  expect(() => authorizeRepairCheck(f, op, 'stable-repair-permission', 'e'.repeat(40))).toThrow(
    'different',
  );
  const dbPath = path.join(f.root, 'retry-reopen.db');
  await f.ctx.db.backup(dbPath);
  const reopened = createDatabase(dbPath, f.ctx.deps.logger);
  try {
    expect(
      JSON.parse(
        (
          reopened
            .prepare('SELECT rewrite_repair FROM task_retry_authorizations WHERE id=?')
            .get(grant.id) as { rewrite_repair: string }
        ).rewrite_repair,
      ),
    ).toEqual(grant.rewriteRepair);
  } finally {
    reopened.close();
  }
});
