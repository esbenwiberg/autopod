import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import { findingId } from '../validation/finding-fingerprint.js';
import { applyOverrides } from '../validation/override-applicator.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import { createValidationPassDelivery } from './validation-pass-delivery.js';
describe('validation successful delivery lifetime', () => {
  it.each(['old review finding', 'unrelated finding'])(
    'refuses delivery despite a persisted dismissal of %s',
    async (text) => {
      const f = createDeliveryFixture();
      f.validating();
      const context = f.passContext();
      const original = {
        ...context.result,
        overall: 'fail' as const,
        taskReview:
          text === 'old review finding'
            ? { status: 'fail' as const, reasoning: 'Previous finding', issues: [text] }
            : null,
        test: { status: 'skip' as const, duration: 1, stdout: 'FAIL retained partial output' },
        infrastructureFailure: {
          phase: 'test' as const,
          code: 'EXEC_EXIT_UNVERIFIED',
          message: 'Unknown native execution',
          retryable: false,
        },
      };
      context.result = applyOverrides(original, [
        { action: 'dismiss', findingId: findingId('task_review', text), description: text },
      ]);
      // Even a stale pass bit cannot authorize delivery beside the native failure.
      context.result.overall = 'pass';
      await expect(f.pass().completeValidationPass.call(f.calls, context)).rejects.toMatchObject({
        code: 'VALIDATION_EXECUTION_UNVERIFIED',
      });
      expect(f.worktreeManager.pushArtifactBranch).not.toHaveBeenCalled();
      expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
      expect(f.provider.createPr).not.toHaveBeenCalled();
      expect(f.mainCaptured.maybeTriggerDependents).not.toHaveBeenCalled();
      expect(f.pod().status).toBe('validating');
      expect(original.test.stdout).toBe('FAIL retained partial output');
    },
  );

  it('embeds GitHub screenshots only against a successfully published artifact ref', async () => {
    const f = createDeliveryFixture();
    f.validating();
    const context = f.passContext();
    context.result.smoke.pages = [
      {
        path: '/',
        status: 'pass',
        screenshotPath: '/workspace/.autopod/screenshots/root.png',
        consoleErrors: [],
        assertions: [],
        loadTime: 1,
      },
    ];
    await f.pass().completeValidationPass.call(f.calls, context);
    expect(f.worktreeManager.pushArtifactBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'autopod/screenshots/prepare',
        paths: ['.autopod/screenshots'],
      }),
    );
    expect(f.provider.createPr).toHaveBeenCalledWith(
      expect.objectContaining({
        screenshots: [
          {
            pagePath: '/',
            imageUrl:
              'https://github.com/org/repo/blob/autopod/screenshots/prepare/.autopod/screenshots/root.png?raw=true',
          },
        ],
      }),
    );
    f.validating();
    f.podRepo.update('prepare', { prUrl: null });
    const publish = f.worktreeManager.pushArtifactBranch;
    if (!publish) throw new Error('Missing artifact publisher');
    vi.mocked(publish).mockResolvedValueOnce(false);
    await f.pass().completeValidationPass.call(f.calls, f.passContext());
    expect(f.provider.createPr).toHaveBeenLastCalledWith(
      expect.objectContaining({ screenshots: [] }),
    );
  });
  it('performs no-PR validated/readiness/dependent effects synchronously before advisory settles', async () => {
    const f = createDeliveryFixture();
    f.validating();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.passCaptured.runAdvisoryAfterValidation.mockImplementationOnce(
      async (_id, _config, result) => {
        await gate;
        return result;
      },
    );
    f.passCaptured.pendingUpdateFromBaseIntents.add('prepare');
    f.podRepo.update('prepare', { lastCorrectionMessage: 'old correction' });
    const owner = createValidationPassDelivery({ ...f.passCaptured, prManagerFactory: () => null });
    const pending = owner.completeValidationPass.call(f.calls, f.passContext());
    expect(f.pod()).toMatchObject({ status: 'validated', lastCorrectionMessage: null });
    expect(f.passCaptured.pendingUpdateFromBaseIntents.has('prepare')).toBe(false);
    expect(f.passCaptured.refreshReadiness).toHaveBeenCalledOnce();
    expect(f.mainCaptured.maybeTriggerDependents).toHaveBeenCalledOnce();
    expect(f.cm.stop).not.toHaveBeenCalled();
    release();
    await pending;
    expect(f.advisoryCurrent).toHaveBeenCalledOnce();
    expect(f.cm.stop).toHaveBeenCalledWith('container-123');
  });
  it('pushes an existing PR without recreating it and routes a fix before auto-approval or stop', async () => {
    const f = createDeliveryFixture();
    const seed = f.pod();
    f.podRepo.insert({
      id: 'fix',
      profileName: seed.profileName,
      task: 'Repair original task',
      status: 'validating',
      runtime: seed.runtime,
      model: seed.model,
      executionTarget: seed.executionTarget,
      branch: seed.branch,
      userId: seed.userId,
      maxValidationAttempts: 3,
      skipValidation: false,
      outputMode: 'pr',
      linkedPodId: 'prepare',
      prUrl: 'https://github.com/org/repo/pull/27',
    });
    f.podRepo.update('fix', {
      containerId: 'container-fix',
      worktreePath: f.directory,
      autoApprove: true,
    });
    const fix = f.podRepo.getOrThrow('fix');
    const context = { ...f.passContext(), podId: 'fix', pod: fix, s2: fix };
    context.result = { ...context.result, podId: 'fix' };
    await f.pass().completeValidationPass.call(f.calls, context);
    expect(f.worktreeManager.mergeBranch).toHaveBeenCalled();
    expect(f.provider.createPr).not.toHaveBeenCalled();
    expect(f.passCaptured.completeFixPodAfterPush).toHaveBeenCalledOnce();
    expect(f.cm.stop).not.toHaveBeenCalled();
    expect(f.calls.approveSession).not.toHaveBeenCalled();
  });
  it('parks credential failure and halts before validated/readiness effects', async () => {
    const f = createDeliveryFixture();
    f.validating();
    vi.mocked(f.worktreeManager.mergeBranch).mockRejectedValueOnce(
      new GitCredentialError('synthetic', 'ado', 'push', 'synthetic'),
    );
    await f.pass().completeValidationPass.call(f.calls, f.passContext());
    expect(f.pod().status).toBe('awaiting_input');
    expect(f.provider.createPr).not.toHaveBeenCalled();
    expect(f.passCaptured.refreshReadiness).not.toHaveBeenCalled();
    expect(f.cm.stop).not.toHaveBeenCalled();
  });
  it('halts on deletion guard, but rethrows ordinary push failures with their identity', async () => {
    const f = createDeliveryFixture();
    f.validating();
    const error = new Error('synthetic push');
    f.passCaptured.handleDeletionGuardError = vi.fn(() => true);
    vi.mocked(f.worktreeManager.mergeBranch).mockRejectedValueOnce(error);
    await f.pass().completeValidationPass.call(f.calls, f.passContext());
    expect(f.pod().status).toBe('failed');
    expect(f.passCaptured.runAdvisoryAfterValidation).not.toHaveBeenCalled();
    f.validating();
    f.passCaptured.handleDeletionGuardError = vi.fn(() => false);
    vi.mocked(f.worktreeManager.mergeBranch).mockRejectedValueOnce(error);
    await expect(f.pass().completeValidationPass.call(f.calls, f.passContext())).rejects.toBe(
      error,
    );
  });
  it('retains fresh stats/waiver metadata, zero-deletion tightening and PR failure still validated', async () => {
    const f = createDeliveryFixture();
    f.validating();
    const context = f.passContext();
    context.validationSyncOk = false;
    await f.pass().completeValidationPass.call(f.calls, context);
    expect(f.worktreeManager.mergeBranch).toHaveBeenCalledWith(
      expect.objectContaining({ targetBranch: 'branch', maxDeletions: 0 }),
    );
    expect(f.provider.createPr).toHaveBeenCalledWith(
      expect.objectContaining({
        filesChanged: 3,
        linesAdded: 50,
        validationWaiver: f.pod().validationWaiver,
        validationResult: context.result,
      }),
    );
    f.validating();
    f.podRepo.update('prepare', { prUrl: null });
    f.provider.createPr.mockRejectedValueOnce(new Error('synthetic PR outage'));
    await f.pass().completeValidationPass.call(f.calls, f.passContext());
    expect(f.pod()).toMatchObject({ status: 'validated', prUrl: null });
  });
  it('skips GitHub artifact publication for ADO and resolves auto-approval dynamically after stop', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    f.validating();
    f.podRepo.update('prepare', { autoApprove: true });
    const context = f.passContext();
    context.profile = { ...context.profile, prProvider: 'ado' };
    context.result.smoke.pages = [
      {
        path: '/',
        status: 'pass',
        screenshotPath: '/workspace/.autopod/screenshots/root.png',
        screenshot: {
          podId: 'prepare',
          source: 'smoke',
          filename: 'root.png',
          relativePath: 'screenshots/prepare/smoke/root.png',
        },
        consoleErrors: [],
        assertions: [],
        loadTime: 1,
      },
    ];
    await f.pass().completeValidationPass.call(f.calls, context);
    expect(f.worktreeManager.pushArtifactBranch).not.toHaveBeenCalled();
    expect(f.provider.createPr).toHaveBeenCalledWith(
      expect.objectContaining({
        screenshots: [],
        rawScreenshots: [{ pagePath: '/', ref: context.result.smoke.pages[0]?.screenshot }],
      }),
    );
    expect(f.cm.stop).toHaveBeenCalledOnce();
    const replacement = vi.fn(async () => {});
    f.calls.approveSession = replacement;
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement).toHaveBeenCalledWith('prepare', { automation: true });
  });
});
