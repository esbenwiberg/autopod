import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeCheckpointFixture,
  preValidationCheckpointFixture,
} from '../test-utils/retained-checkpoint-helpers.js';
import { createCompletionGuards } from './completion-guards.js';
import { checkpointHash } from './retained-checkpoint-repository.js';

const fixtures: Awaited<ReturnType<typeof preValidationCheckpointFixture>>[] = [];
async function fixture() {
  const f = await preValidationCheckpointFixture();
  fixtures.push(f);
  const retries = f.ctx.podRepo.taskRetries;
  const hasInfrastructureBlocker = f.ctx.podRepo.hasInfrastructureBlocker;
  if (!retries || !hasInfrastructureBlocker) throw new Error('Missing recovery fixture ledgers');
  return { ...f, retries, hasInfrastructureBlocker };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.recovery.wait(f.input.id);
    f.ctx.db.close();
    vi.unstubAllEnvs();
    await rm(f.root, { recursive: true, force: true });
  }
});

describe('retained continuation before validation', () => {
  it('preserves a real null result and recorded need, queues only fresh checks, and replays once', async () => {
    const f = await fixture();
    const before = f.pod();
    const retries = f.retries.state(f.podId);
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    const operation = f.recovery.list(f.podId)[0];
    if (!operation) throw new Error('Missing claimed recovery');
    expect(operation.blocked).toBeNull();
    expect(operation.originalEvidence).toMatchObject({
      result: null,
      infrastructureReports: f.infrastructureReports,
    });
    expect(operation.binding.resultHash).toBe(f.input.expectedResultHash);
    expect(f.pod()).toMatchObject({
      status: 'queued',
      skipAgent: true,
      autoApprove: false,
      lifecycleGeneration: before.lifecycleGeneration + 1,
      lastValidationResult: null,
      validationAttempts: before.validationAttempts,
    });
    expect(f.retries.state(f.podId)).toEqual(retries);
    expect(f.ctx.escalationRepo.getOrThrow(f.report.id)).toEqual(f.originalReport);
    expect(f.hasInfrastructureBlocker(f.podId)).toBe(false);
    expect(() => f.ctx.podRepo.delete(f.podId)).toThrow('remain retained');
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
    expect(f.cm.spawn).not.toHaveBeenCalled();
    expect(f.cm.start).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
  });

  it('runs the real manager checks/review after a pre-validation report, without restarting coding or publishing', async () => {
    const f = await fixture();
    vi.stubEnv('DATA_DIR', f.root);
    await materializeCheckpointFixture(f);
    f.worktrees.selectRetainedContinuationSource = vi.fn(async (input) => {
      const source = await f.worktrees.inspectSourceAdoption(input.worktreePath, input.branch);
      return {
        head: source.commitSha,
        tree: source.treeSha,
        baseCommitSha: f.input.checkpointHead,
      };
    });
    const validate = vi.mocked(f.ctx.validationEngine.validate).getMockImplementation();
    if (!validate) throw new Error('Missing validation fixture');
    vi.mocked(f.ctx.validationEngine.validate).mockImplementation(async (config) => ({
      ...(await validate(config)),
      taskReview: {
        status: 'pass',
        reasoning: 'Independent review of the selected candidate',
        issues: [],
        model: 'fixture',
        screenshots: [],
        diff: config.diff,
      },
    }));
    f.retries.authorize(
      f.podId,
      'prevalidation-check',
      'One checks-only execution after inspected infrastructure need',
      f.actor,
    );
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    await f.manager.processPod(f.podId);
    expect(f.pod().status, f.pod().failureReason ?? '').toBe('validated');
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      originalEvidence: { result: null, infrastructureReports: f.infrastructureReports },
      checked: { result: { overall: 'pass', taskReview: { status: 'pass' } } },
    });
    expect(f.ctx.validationEngine.validate).toHaveBeenCalledTimes(1);
    expect(f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(f.ctx.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.cm.kill).not.toHaveBeenCalled();
    expect(f.ctx.escalationRepo.getOrThrow(f.report.id)).toEqual(f.originalReport);
  });

  it('never treats the hash of null as evidence or extends legacy checkpoint recovery', async () => {
    const f = await fixture();
    await expect(
      f.recovery.continueRetained(
        f.podId,
        { ...f.input, expectedResultHash: checkpointHash(null) },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: 'STALE_CHECKPOINT_RECOVERY' });
    await expect(f.submit()).rejects.toMatchObject({ code: 'CHECKPOINT_RECOVERY_BLOCKED' });
    expect(f.recovery.list(f.podId)).toEqual([]);
  });

  it.each([
    'missing-report',
    'old-generation',
    'unpreserved',
    'unsettled',
    'wrong-state',
  ])('does not admit absent or incomplete infrastructure evidence: %s', async (kind) => {
    const f = await fixture();
    if (kind === 'missing-report')
      f.ctx.db.prepare('DELETE FROM escalations WHERE id=?').run(f.report.id);
    if (kind === 'old-generation')
      f.ctx.db
        .prepare('UPDATE escalations SET payload=? WHERE id=?')
        .run(JSON.stringify({ ...f.report.payload, lifecycleGeneration: 0 }), f.report.id);
    if (kind === 'unpreserved')
      f.ctx.db
        .prepare('UPDATE pod_finalizations SET source_preserved_at=NULL WHERE pod_id=?')
        .run(f.podId);
    if (kind === 'unsettled')
      f.ctx.db
        .prepare('UPDATE pod_finalizations SET agent_settled_at=NULL WHERE pod_id=?')
        .run(f.podId);
    if (kind === 'wrong-state') f.ctx.podRepo.update(f.podId, { status: 'review_required' });
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toMatchObject({
      code: 'CHECKPOINT_RECOVERY_BLOCKED',
    });
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    'interactive',
    'incomplete',
    'oversized',
  ])('rejects unsafe report evidence: %s', async (kind) => {
    const f = await fixture();
    const payload = {
      ...f.report.payload,
      ...(kind === 'interactive'
        ? { requiresResponse: true }
        : kind === 'incomplete'
          ? { needs: '' }
          : { description: 'x'.repeat(65537) }),
    };
    f.ctx.db
      .prepare('UPDATE escalations SET payload=? WHERE id=?')
      .run(JSON.stringify(payload), f.report.id);
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toMatchObject({
      code: 'CHECKPOINT_RECOVERY_BLOCKED',
    });
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('quarantines preparation if the recorded need changes after claim', async () => {
    const f = await fixture();
    if (!f.deps.prepare) throw new Error('Missing preparation fixture');
    vi.mocked(f.deps.prepare).mockImplementation(async () => {
      f.ctx.escalationRepo.insert({ ...f.report, id: 'late-report' });
      return f.prepared;
    });
    const original = f.pod();
    await f.recovery.continueRetained(f.podId, f.input, f.actor);
    await f.recovery.wait(f.input.id);
    expect(f.recovery.list(f.podId)[0]).toMatchObject({
      blocked: { code: 'STALE_CHECKPOINT_RECOVERY' },
      activated: null,
    });
    expect(f.pod()).toEqual(original);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('retains the pending guidance guard for pre-validation failures', async () => {
    const f = await fixture();
    const guards = createCompletionGuards({ podRepo: f.ctx.podRepo, nudgeRepo: f.ctx.nudgeRepo });
    vi.mocked(f.deps.assertGuidanceCollected).mockImplementation(guards.assertGuidanceCollected);
    f.ctx.nudgeRepo.queue(f.podId, 'Preserve this unread operator guidance');
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toMatchObject({
      code: 'UNCOLLECTED_HUMAN_GUIDANCE',
    });
    expect(f.ctx.nudgeRepo.hasPending(f.podId)).toBe(true);
    expect(f.recovery.list(f.podId)).toEqual([]);
  });

  it('refuses active workers even when completion claims preservation', async () => {
    const f = await fixture();
    const runs = f.ctx.podRepo.taskExecutions;
    const pod = f.pod();
    if (!runs || !pod.finalization) throw new Error('Missing execution fixture');
    runs.beginRun(f.podId, pod.lifecycleGeneration, pod.finalization.cycle, {
      runtime: pod.runtime,
      model: pod.model,
      providerAccountId: null,
      resource: { containerId: f.containerId, executionTarget: pod.executionTarget },
    });
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toThrow();
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });

  it('rejects another recorded need arriving during provider observation', async () => {
    const f = await fixture();
    vi.mocked(f.cm.getStatus).mockImplementationOnce(async () => {
      f.ctx.escalationRepo.insert({
        ...f.report,
        id: 'additional-report',
        payload: { ...f.report.payload, needs: 'A different qualified runner' },
      });
      return 'stopped';
    });
    await expect(f.recovery.continueRetained(f.podId, f.input, f.actor)).rejects.toMatchObject({
      code: 'STALE_CHECKPOINT_RECOVERY',
    });
    expect(f.recovery.list(f.podId)).toEqual([]);
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  });
});
