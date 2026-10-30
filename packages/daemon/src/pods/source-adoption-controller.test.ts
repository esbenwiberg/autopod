import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceControllerFixture } from '../test-utils/source-controller-helpers.js';
import { createSourceAdoptionController } from './source-adoption-controller.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(options: { ignoredCollision?: boolean } = {}) {
  const s = await createSourceControllerFixture(options);
  roots.push(s.root);
  return s;
}

describe('durable source adoption coordinator (real Git/filesystem, mocked validator/data plane)', () => {
  it.each(['missing', 'outcome'] as const)(
    'refuses %s validation dispatch before source adoption or provider calls',
    async (kind) => {
      const s = await fixture();
      const repo = s.f.podRepo;
      repo.update(s.podId, { containerId: null });
      repo.update(s.podId, {
        executionTarget: 'sandbox',
        containerId: '11111111-1111-4111-8111-111111111111',
        lastValidationResult: null,
      });
      const retries = repo.taskRetries;
      const executions = repo.validationExecutions;
      if (!retries || !executions) throw new Error('Missing execution ledgers');
      const pod = repo.getOrThrow(s.podId);
      const admission = retries.admit(
        s.podId,
        pod.lifecycleGeneration,
        {
          source: 'a'.repeat(64),
          contract: 'b'.repeat(64),
          commands: 'c'.repeat(64),
          environment: null,
          implementation: null,
        },
        'd'.repeat(64),
        [],
      );
      retries.start(admission.id);
      const id = executions.dispatch(pod, admission.id, 1, 'test-scope');
      if (!id) throw new Error('Missing dispatch');
      if (kind === 'outcome')
        executions.recordOutcome(
          {
            podId: s.podId,
            executionDispatchId: id,
            attempt: 1,
            timestamp: '2026-10-29T00:00:00Z',
            overall: 'fail',
            duration: 1,
            smoke: {
              status: 'pass',
              build: { status: 'pass', output: '', duration: 0 },
              health: { status: 'skip', url: '', responseCode: null, duration: 0 },
              pages: [],
            },
            taskReview: null,
          },
          id,
        );
      retries.finish(admission.id, 'nonretryable', 1);
      const before = repo.getOrThrow(s.podId);
      await expect(s.submit()).rejects.toMatchObject({ code: 'VALIDATION_EXECUTION_UNVERIFIED' });
      expect(s.cm.getResourceKey).not.toHaveBeenCalled();
      expect(s.cm.start).not.toHaveBeenCalled();
      expect(s.cm.execStreaming).not.toHaveBeenCalled();
      expect(repo.getOrThrow(s.podId)).toEqual(before);
      expect((await s.git(s.host, 'rev-parse', 'HEAD')).stdout.trim()).toBe(s.old);
      expect(await readFile(path.join(s.guest, 'ignored-report.bin'))).toEqual(
        Buffer.from([0, 1, 255]),
      );
    },
  );

  it('preserves BOTH old workspaces, applies exact source and invokes real source-bound revalidation without delivery or reset', async () => {
    const s = await fixture();
    let running = true;
    vi.mocked(s.cm.getStatus).mockImplementation(async () => (running ? 'running' : 'stopped'));
    vi.mocked(s.cm.stop).mockImplementation(async () => {
      running = false;
    });
    vi.mocked(s.harness.captured.containerManagerFactory.get).mockReturnValue(s.cm);
    const before = s.f.db.prepare('SELECT * FROM task_executions WHERE pod_id=?').get(s.podId);
    const first = await s.submit();
    expect(first.stage).toBe('claimed');
    await s.controller.wait(s.input.id);
    const [state] = s.controller.list(s.podId);
    expect(
      state,
      JSON.stringify(
        s.f.db
          .prepare(
            "SELECT event FROM source_adoption_events WHERE adoption_id=? AND json_extract(event,'$.observation')='source-command-exited'",
          )
          .all(s.input.id),
      ),
    ).toMatchObject({
      stage: 'checked',
      validation: 'pass',
      delivery: 'not-authorized',
      reports: 'not-released',
      error: null,
    });
    expect(s.f.pod().lifecycleGeneration).toBe(s.input.expectedGeneration + 1);
    expect(s.f.pod().validationAttempts).toBe(4);
    expect(s.f.pod().lastValidationResult?.overall).toBe('pass');
    for (const workspace of [s.host, s.guest])
      expect((await s.git(workspace, 'rev-parse', 'HEAD')).stdout.trim()).toBe(s.target);
    const saved = s.f.podRepo.sourceAdoptions?.get(s.input.id)?.preservation;
    expect(saved).not.toBeNull();
    expect(await readFile(path.join(saved!.host, 'code.txt'), 'utf8')).toBe('original');
    expect(await readFile(path.join(saved!.container, 'ignored-report.bin'))).toEqual(
      Buffer.from([0, 1, 255]),
    );
    expect(await readFile(path.join(s.guest, 'ignored-report.bin'))).toEqual(
      Buffer.from([0, 1, 255]),
    );
    expect(s.harness.captured.worktreeManager.pullBranch).not.toHaveBeenCalled();
    expect(s.f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(s.cm.stop).not.toHaveBeenCalled();
    expect(running).toBe(true);
    expect(s.harness.captured.maybeTriggerDependents).not.toHaveBeenCalled();
    expect(s.harness.oldReview).not.toHaveBeenCalled();
    expect(s.f.ctx.validationEngine.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 4,
        validationSetupCommand: 'npm ci',
        priorReviewBatch: undefined,
      }),
      expect.any(AbortSignal),
      undefined,
      expect.any(Object),
    );
    expect(s.f.db.prepare('SELECT * FROM task_executions WHERE pod_id=?').get(s.podId)).toEqual(
      before,
    );
    expect(() => s.f.podRepo.sourceAdoptions?.assertDeliveryAllowed(s.podId)).toThrow();
  });
  it('coalesces concurrent identical POSTs and after-memory-restart observation without a second source action', async () => {
    const s = await fixture();
    await Promise.all([s.submit(), s.submit()]);
    await s.controller.wait(s.input.id);
    const commands = s.cm.execStreaming.mock.calls.length;
    const restarted = createSourceAdoptionController(s.deps);
    await expect(restarted.submit(s.podId, s.input, s.actor)).resolves.toMatchObject({
      stage: 'checked',
    });
    expect(s.cm.execStreaming).toHaveBeenCalledTimes(commands);
    expect(s.worktrees.applySourceAdoption).toHaveBeenCalledTimes(1);
    await expect(
      restarted.submit(s.podId, { ...s.input, targetHeadSha: 'c'.repeat(40) }, s.actor),
    ).rejects.toMatchObject({ code: 'SOURCE_ADOPTION_CONFLICT' });
  });
  it('refuses unknown original execution BEFORE invalidation, SDK reads or snapshot capture', async () => {
    const s = await fixture();
    vi.spyOn(s.f.podRepo.taskExecutions!, 'assertCanDelete').mockImplementation(() => {
      throw new Error('Original execution unsettled');
    });
    await expect(s.submit()).rejects.toThrow('Original execution unsettled');
    expect(s.cm.getResourceKey).not.toHaveBeenCalled();
    expect(s.cm.extractDirectoryFromContainer).not.toHaveBeenCalled();
    expect(s.f.pod().lifecycleGeneration).toBe(s.input.expectedGeneration);
    expect(s.controller.list(s.podId)).toEqual([]);
  });
  it('refuses Native Goals and pending human guidance before claiming or preparing source', async () => {
    const s = await fixture();
    s.deps.isNativeGoal = () => true;
    await expect(s.submit()).rejects.toMatchObject({ code: 'SOURCE_GOAL_UNSUPPORTED' });
    s.deps.isNativeGoal = () => false;
    s.deps.assertGuidanceCollected = () => {
      throw new Error('Unacknowledged human guidance');
    };
    await expect(s.submit()).rejects.toThrow('Unacknowledged human guidance');
    expect(s.controller.list(s.podId)).toEqual([]);
    expect(s.cm.execStreaming).not.toHaveBeenCalled();
  });
  it('retains a partial application and BOTH old snapshots when the container has an ignored-report collision', async () => {
    const s = await fixture({ ignoredCollision: true });
    await s.submit();
    await s.controller.wait(s.input.id);
    expect(s.controller.list(s.podId)[0]).toMatchObject({
      stage: 'applying',
      error: 'SOURCE_COMMAND_FAILED',
      validation: 'pending',
    });
    expect((await s.git(s.host, 'rev-parse', 'HEAD')).stdout.trim()).toBe(s.target);
    expect((await s.git(s.guest, 'rev-parse', 'HEAD')).stdout.trim()).toBe(s.old);
    expect(s.f.pod().lastValidationResult).toBeNull();
    expect(s.f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(await readFile(path.join(s.guest, 'ignored-report.bin'))).toEqual(
      Buffer.from([0, 1, 255]),
    );
    const count = s.cm.execStreaming.mock.calls.length;
    await s.submit();
    expect(s.cm.execStreaming).toHaveBeenCalledTimes(count);
    expect(() => s.f.podRepo.delete(s.podId)).toThrow();
  });
  it('does not certify validator success when tracked source changes during dependency/check execution', async () => {
    const s = await fixture();
    s.f.ctx.validationEngine.validate.mockImplementationOnce(async () => {
      await writeFile(path.join(s.host, 'code.txt'), 'unexpected lock/source drift');
      return s.harness.result;
    });
    await s.submit();
    await s.controller.wait(s.input.id);
    expect(s.controller.list(s.podId)[0]).toMatchObject({
      stage: 'checking',
      validation: 'pending',
    });
    expect(s.f.pod().lastValidationResult).toBeNull();
    expect(s.harness.captured.completeRevalidationPass).not.toHaveBeenCalled();
    expect(
      s.f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM source_adoption_events WHERE json_extract(event,'$.observation')='unaccepted-validation-result'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
  it('holds stopped legacy resources after an uncertain/rejected wake without credentials, source fetch, reset or retry', async () => {
    const s = await fixture();
    vi.mocked(s.cm.getStatus).mockResolvedValue('stopped');
    vi.mocked(s.cm.start).mockRejectedValue(
      Object.assign(new Error('Legacy wake unverified'), {
        code: 'SANDBOX_WAKEUP_LEGACY_UNVERIFIED',
      }),
    );
    await s.submit();
    await s.controller.wait(s.input.id);
    expect(s.controller.list(s.podId)[0]).toMatchObject({
      stage: 'claimed',
      error: 'SANDBOX_WAKEUP_LEGACY_UNVERIFIED',
    });
    await s.submit();
    expect(s.cm.start).toHaveBeenCalledTimes(1);
    expect(s.worktrees.prepareSourceAdoption).not.toHaveBeenCalled();
    expect(s.f.pod().lifecycleGeneration).toBe(s.input.expectedGeneration);
  });
  it('observes remote movement without pushing or certifying the pinned request as current remote source', async () => {
    const s = await fixture();
    s.worktrees.observeSourceBranch.mockResolvedValue('c'.repeat(40));
    await s.submit();
    await s.controller.wait(s.input.id);
    expect(s.controller.list(s.podId)[0]).toMatchObject({
      stage: 'applying',
      error: 'SOURCE_CHANGED_DURING_CHECKS',
    });
    expect(s.f.pod().lastValidationResult).toBeNull();
    expect(s.f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(s.worktrees.pushBranch).not.toHaveBeenCalled();
  });
});
