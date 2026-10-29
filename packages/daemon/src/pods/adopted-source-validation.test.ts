import { AutopodError } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';
import { createAdoptedSourceValidationFixture } from '../test-utils/adopted-source-validation-helpers.js';
import { createSourceAdoptionRepository } from './source-adoption-repository.js';
import { ValidationSupersededError } from './validation-ownership.js';

describe('source-bound checks-only revalidation', () => {
  it('runs fresh setup/checks against pinned source without pulling, rewriting, waking, delivering or resetting attempts', async () => {
    const s = createAdoptedSourceValidationFixture();
    const before = s.f.db.prepare('SELECT * FROM task_executions WHERE pod_id=?').get(s.id);
    await expect(s.run()).resolves.toEqual({ newCommits: true, result: 'pass' });
    expect(s.f.pod().validationAttempts).toBe(4);
    expect(s.f.pod().lastValidationResult?.overall).toBe('pass');
    expect(s.f.pod().status).toBe('validated');
    expect(s.captured.worktreeManager.pullBranch).not.toHaveBeenCalled();
    expect(s.captured.prepareWorkspaceForValidation).not.toHaveBeenCalled();
    expect(s.f.ctx.containerManager.start).not.toHaveBeenCalled();
    expect(s.captured.enqueueSession).not.toHaveBeenCalled();
    expect(s.f.ctx.runtime.spawn).not.toHaveBeenCalled();
    expect(s.f.ctx.runtime.resume).not.toHaveBeenCalled();
    expect(s.captured.applySkipValidationDecision).not.toHaveBeenCalled();
    expect(s.captured.maybeTriggerDependents).not.toHaveBeenCalled();
    expect(s.oldReview).not.toHaveBeenCalled();
    expect(s.f.ctx.validationEngine.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 4,
        validationSetupCommand: 'npm ci',
        priorReviewBatch: undefined,
        preSubmitReview: undefined,
        skipPhases: [],
      }),
      expect.any(AbortSignal),
      undefined,
      expect.any(Object),
    );
    expect(s.verifySource).toHaveBeenCalledTimes(4);
    expect(s.captured.completeRevalidationPass).toHaveBeenCalledWith(
      expect.objectContaining({ checksOnly: true }),
    );
    expect(s.f.db.prepare('SELECT * FROM task_executions WHERE pod_id=?').get(s.id)).toEqual(
      before,
    );
  });
  it('accepts a legitimately invalidated formerly-validated pod, not an old pass', async () => {
    const s = createAdoptedSourceValidationFixture();
    s.journal.owned('source-checks', () => {
      s.f.events.transition(s.f.pod(), 'validating');
      s.f.events.transition(s.f.pod(), 'validated');
    });
    await expect(s.run()).resolves.toMatchObject({ result: 'pass' });
  });
  it('does not let ordinary checks-only recovery pull advanced source after adoption custody exists', async () => {
    const s = createAdoptedSourceValidationFixture();
    await expect(
      s.workflow().revalidateSession.call({ approveSession: vi.fn(async () => {}) }, s.id, {
        force: true,
        checksOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHECKS_REQUIRED' });
    expect(s.captured.worktreeManager.pullBranch).not.toHaveBeenCalled();
    expect(s.f.pod().validationAttempts).toBe(3);
  });
  it('requires explicit dependency preparation before claiming or running checks', async () => {
    const s = createAdoptedSourceValidationFixture(false, { setup: null });
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_DEPENDENCY_SETUP_REQUIRED' });
    expect(s.verifySource).not.toHaveBeenCalled();
    expect(s.captured.validateWithInfrastructureRetries).not.toHaveBeenCalled();
  });
  it.each([{ disabled: true }, { waived: true }])(
    'does not carry validation bypasses into a new source pass (%j)',
    async (options) => {
      const s = createAdoptedSourceValidationFixture(false, options);
      await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_CHECKS_BYPASSED' });
      expect(s.verifySource).not.toHaveBeenCalled();
      expect(s.captured.publishValidationResult).not.toHaveBeenCalled();
    },
  );
  it('refuses an old canonical pass which mutation admission did not invalidate', async () => {
    const s = createAdoptedSourceValidationFixture();
    s.journal.owned('source-checks', () =>
      s.f.podRepo.update(s.id, { lastValidationResult: s.result }),
    );
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_VALIDATION_NOT_INVALIDATED' });
    expect(s.verifySource).not.toHaveBeenCalled();
    expect(s.f.pod().lastValidationResult).toEqual(s.result);
  });
  it('claims only one invocation before any external await, even for concurrent callers', async () => {
    const s = createAdoptedSourceValidationFixture();
    let release = () => {};
    s.verifySource.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = s.run();
    await vi.waitFor(() => expect(s.verifySource).toHaveBeenCalledTimes(1));
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_CHECKS_ALREADY_CLAIMED' });
    release();
    await first;
    expect(s.captured.validateWithInfrastructureRetries).toHaveBeenCalledTimes(1);
  });
  it('does not replay a claimed invocation after an actual disk reopen', async () => {
    const s = createAdoptedSourceValidationFixture(true);
    await s.run();
    s.f.reopen();
    const journal = createSourceAdoptionRepository(s.f.db);
    expect(() => journal.claimChecksInvocation('source-checks', () => {})).toThrow();
    expect(() => s.f.db.prepare('DELETE FROM source_check_invocations').run()).toThrow();
  });
  it('does not clear original termination fences or launch checks when original exit is unknown', async () => {
    const s = createAdoptedSourceValidationFixture();
    s.captured.assertExecutionTerminationVerified = () => {
      throw new AutopodError('Unknown original exit', 'EXEC_EXIT_UNVERIFIED', 409);
    };
    await expect(s.run()).rejects.toMatchObject({ code: 'EXEC_EXIT_UNVERIFIED' });
    expect(s.verifySource).not.toHaveBeenCalled();
    expect(s.f.pod().validationAttempts).toBe(3);
    expect(s.f.ctx.validationEngine.validate).not.toHaveBeenCalled();
    expect(s.f.db.prepare('SELECT COUNT(*) AS count FROM source_check_invocations').get()).toEqual({
      count: 0,
    });
  });
  it('refuses unavailable original resources instead of issuing a second wakeup or replacement', async () => {
    const s = createAdoptedSourceValidationFixture();
    vi.mocked(s.f.ctx.containerManager.getStatus).mockResolvedValue('stopped');
    await expect(s.run()).rejects.toMatchObject({ code: 'VALIDATION_RESOURCE_UNAVAILABLE' });
    expect(s.f.ctx.containerManager.start).not.toHaveBeenCalled();
    expect(s.captured.enqueueSession).not.toHaveBeenCalled();
    expect(s.captured.publishValidationResult).not.toHaveBeenCalled();
  });
  it('retains an unaccepted returned result when source drifts during checks, without publishing a pass', async () => {
    const s = createAdoptedSourceValidationFixture();
    let count = 0;
    s.verifySource.mockImplementation(async () => {
      if (++count === 4) throw new AutopodError('Source drift', 'SOURCE_CHANGED', 409);
    });
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(s.f.pod().lastValidationResult).toBeNull();
    expect(s.f.pod().status).toBe('review_required');
    expect(s.captured.publishValidationResult).not.toHaveBeenCalled();
    expect(s.captured.completeRevalidationPass).not.toHaveBeenCalled();
    const observations = s.f.db
      .prepare(
        "SELECT event FROM source_adoption_events WHERE json_extract(event,'$.observation')='unaccepted-validation-result'",
      )
      .all() as { event: string }[];
    expect(observations).toHaveLength(1);
    expect(JSON.parse(observations[0]?.event ?? '{}').result).toEqual(s.result);
  });
  it('does not clear the original resource binding on a provider 404', async () => {
    const s = createAdoptedSourceValidationFixture();
    const original = s.f.pod().containerId;
    vi.mocked(s.f.ctx.containerManager.getStatus).mockRejectedValue({ statusCode: 404 });
    await expect(s.run()).rejects.toMatchObject({ statusCode: 404 });
    expect(s.f.pod().containerId).toBe(original);
    expect(s.captured.enqueueSession).not.toHaveBeenCalled();
    expect(s.f.ctx.containerManager.start).not.toHaveBeenCalled();
  });
  it('will not certify a passing result which skipped dependency preparation', async () => {
    const s = createAdoptedSourceValidationFixture();
    vi.mocked(s.f.ctx.validationEngine.validate).mockResolvedValue({
      ...s.result,
      setup: { status: 'skip', output: '', duration: 0 },
    });
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_DEPENDENCY_SETUP_UNVERIFIED' });
    expect(s.f.pod().lastValidationResult).toBeNull();
    expect(s.captured.publishValidationResult).not.toHaveBeenCalled();
  });
  it('rechecks ownership after rejected credential awaits without poisoning the replacement lifecycle', async () => {
    const s = createAdoptedSourceValidationFixture();
    let reject = (_error: Error) => {};
    s.captured.validationEnvironmentForPod.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const run = s.run();
    const rejection = expect(run).rejects.toMatchObject({ code: 'STALE_VALIDATION_EXECUTION' });
    await vi.waitFor(() => expect(s.captured.validationEnvironmentForPod).toHaveBeenCalled());
    expect(() => s.f.podRepo.incrementLifecycleGeneration(s.id)).toThrow();
    // Simulate an external/legacy replacement, not an authorized competing control.
    s.f.db
      .prepare(
        "UPDATE pods SET lifecycle_generation=lifecycle_generation+1,status='failed',failure_reason='New owner failure' WHERE id=?",
      )
      .run(s.id);
    reject(new Error('Old credential await rejected'));
    await rejection;
    expect(s.f.pod().failureReason).toBe('New owner failure');
    expect(s.f.pod().lastValidationResult).toBeNull();
    expect(s.f.ctx.validationEngine.validate).not.toHaveBeenCalled();
  });
  it('rechecks the actual validation invocation after asynchronous source verification', async () => {
    const s = createAdoptedSourceValidationFixture();
    let owns = true;
    let count = 0;
    s.captured.claimValidation.mockImplementation(() => ({
      assertCurrent() {
        if (!owns) throw new ValidationSupersededError();
        return s.f.pod();
      },
      isCurrent: () => owns,
    }));
    s.verifySource.mockImplementation(async () => {
      if (++count === 4) {
        owns = false;
        s.f.podRepo.update(s.id, { failureReason: 'Another validation owns this epoch' });
      }
    });
    await expect(s.run()).rejects.toMatchObject({ code: 'STALE_VALIDATION_EXECUTION' });
    expect(s.f.pod().status).toBe('validating');
    expect(s.f.pod().failureReason).toBe('Another validation owns this epoch');
    expect(s.f.pod().lastValidationResult).toBeNull();
    expect(s.captured.publishValidationResult).not.toHaveBeenCalled();
  });
  it('does not permit a native Goal to borrow a legacy source-check admission', async () => {
    const s = createAdoptedSourceValidationFixture();
    await s.f.goal();
    s.live.launchConfiguration = s.f.live.launchConfiguration;
    await expect(s.run()).rejects.toMatchObject({ code: 'SOURCE_GOAL_UNSUPPORTED' });
    expect(s.verifySource).not.toHaveBeenCalled();
  });
});
