import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';

describe('delivery PR commands', () => {
  it('publishes the feature branch before creating a PR and persists retry URL', async () => {
    const f = createDeliveryFixture();
    await f.pr().retryCreatePr('prepare');
    expect(f.worktreeManager.pushBranch).toHaveBeenCalledWith(
      f.directory,
      'branch',
      expect.objectContaining({ pat: 'synthetic-git-key', onPrepared: expect.any(Function) }),
    );
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.podRepo.sourcePublications?.latestConfirmedForMerge?.(f.pod())).toBeTruthy();
    expect(f.provider.createPr).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'branch',
        baseBranch: 'main',
        screenshots: [],
        validationResult: f.pod().lastValidationResult,
      }),
    );
    expect(vi.mocked(f.worktreeManager.pushBranch).mock.invocationCallOrder[0]).toBeLessThan(
      f.provider.createPr.mock.invocationCallOrder[0] ?? 0,
    );
    expect(f.pod().prUrl).toBe('https://github.com/org/repo/pull/27');
    expect(f.pod().status).toBe('validated');
  });
  it('rejects active, existing-PR and missing-worktree retry admission before mutation', async () => {
    const f = createDeliveryFixture();
    const pr = f.pr();
    f.podRepo.update('prepare', { status: 'running' });
    await expect(pr.retryCreatePr('prepare')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    f.podRepo.update('prepare', { status: 'validated', prUrl: 'existing' });
    await expect(pr.retryCreatePr('prepare')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    f.podRepo.update('prepare', { prUrl: null, worktreePath: null });
    await expect(pr.retryCreatePr('prepare')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.provider.createPr).not.toHaveBeenCalled();
  });
  it('preserves GitCredentialError identity and never creates a PR after the failed push', async () => {
    const f = createDeliveryFixture();
    const failure = new GitCredentialError('synthetic auth', 'ado', 'push', 'synthetic');
    vi.mocked(f.worktreeManager.pushBranch).mockRejectedValueOnce(failure);
    await expect(f.pr().retryCreatePr('prepare')).rejects.toBe(failure);
    expect(f.provider.createPr).not.toHaveBeenCalled();
  });
  it('retains deletion-guard and ordinary push error classification', async () => {
    const f = createDeliveryFixture();
    const failure = new Error('synthetic push');
    f.prCaptured.handleDeletionGuardError = vi.fn(() => true);
    vi.mocked(f.worktreeManager.pushBranch).mockRejectedValueOnce(failure);
    await expect(f.pr().retryCreatePr('prepare')).rejects.toMatchObject({
      code: 'WORKTREE_COMPROMISED',
    });
    f.prCaptured.handleDeletionGuardError = vi.fn(() => false);
    vi.mocked(f.worktreeManager.pushBranch).mockRejectedValueOnce(failure);
    await expect(f.pr().retryCreatePr('prepare')).rejects.toMatchObject({
      code: 'BRANCH_PUSH_FAILED',
      statusCode: 502,
    });
  });
  it('binds ensureRemoteBranch to the original manager and treats its failure as best effort', async () => {
    const f = createDeliveryFixture();
    let receiver: unknown;
    f.worktreeManager.ensureRemoteBranch = vi.fn(async function (this: unknown, { branch }) {
      receiver = this;
      return { branch, created: true };
    });
    await f.pr().ensurePrBaseBranchOnOrigin(f.pod(), f.passContext().profile, 'release', 'test');
    expect(receiver).toBe(f.worktreeManager);
    vi.mocked(f.worktreeManager.ensureRemoteBranch).mockRejectedValueOnce(
      new Error('synthetic ensure failure'),
    );
    await expect(
      f.pr().ensurePrBaseBranchOnOrigin(f.pod(), f.passContext().profile, 'release', 'test'),
    ).resolves.toBeUndefined();
  });
  it.each([
    'failed-checks',
    'active-checks',
  ] as const)('does not publish from a superseded or unsettled validation certificate (%s)', async (kind) => {
    const f = createDeliveryFixture();
    if (kind === 'failed-checks')
      f.podRepo.update('prepare', {
        lastValidationResult: { ...f.pod().lastValidationResult!, overall: 'fail' },
      });
    else {
      const ledger = f.podRepo.taskRetries;
      if (!ledger) throw new Error('Missing retry ledger');
      const attempt = ledger.admit(
        'prepare',
        f.pod().lifecycleGeneration,
        { source: null, contract: null, commands: null, environment: null, implementation: null },
        'a'.repeat(64),
        [],
      );
      ledger.start(attempt.id);
    }
    await expect(f.pr().retryCreatePr('prepare')).rejects.toMatchObject({
      code: 'SOURCE_PUBLICATION_RECONCILIATION_REQUIRED',
    });
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.provider.createPr).not.toHaveBeenCalled();
  });

  it('retains PR creation failure classification without persisting a fabricated URL', async () => {
    const f = createDeliveryFixture();
    f.provider.createPr.mockRejectedValueOnce(new Error('synthetic create'));
    await expect(f.pr().retryCreatePr('prepare')).rejects.toMatchObject({
      code: 'PR_CREATION_FAILED',
    });
    expect(f.pod().prUrl).toBeNull();
  });
});
