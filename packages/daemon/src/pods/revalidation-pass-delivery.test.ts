import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture } from '../test-utils/delivery-helpers.js';
import { GitCredentialError } from '../worktrees/local-worktree-manager.js';
import { createRevalidationPassDelivery } from './revalidation-pass-delivery.js';
describe('separate human revalidation delivery lifetime', () => {
  it.each([null, 'https://github.com/org/repo/pull/27'])(
    'checks-only success never publishes, creates or approves a PR (%s)',
    async (prUrl) => {
      vi.useFakeTimers();
      try {
        const f = createDeliveryFixture();
        f.validating();
        f.podRepo.update('prepare', { prUrl, autoApprove: true });
        await expect(
          f.repass().completeRevalidationPass.call(f.calls, {
            ...f.passContext(),
            revalDefaultBranch: 'main',
            newCommits: false,
            checksOnly: true,
          }),
        ).resolves.toEqual({ newCommits: false, result: 'pass' });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.pod()).toMatchObject({ status: 'validated', prUrl });
        expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
        expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
        expect(f.passCaptured.prManagerFactory).not.toHaveBeenCalled();
        expect(f.provider.createPr).not.toHaveBeenCalled();
        expect(f.calls.approveSession).not.toHaveBeenCalled();
        expect(f.passCaptured.maybeTriggerDependents).not.toHaveBeenCalled();
        expect(f.passCaptured.runAdvisoryAfterValidation).not.toHaveBeenCalled();
        expect(f.passCaptured.refreshReadiness).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it('retains synchronous no-PR publication before advisory and the original return shape', async () => {
    const f = createDeliveryFixture();
    f.validating();
    const owner = createRevalidationPassDelivery({
      ...f.passCaptured,
      prManagerFactory: () => null,
    });
    const pending = owner.completeRevalidationPass.call(f.calls, {
      ...f.passContext(),
      revalDefaultBranch: 'main',
      newCommits: true,
    });
    expect(f.pod().status).toBe('validated');
    expect(f.passCaptured.refreshReadiness).toHaveBeenCalledOnce();
    await expect(pending).resolves.toEqual({ newCommits: true, result: 'pass' });
  });
  it('continues after a handled deletion guard and always sends maxDeletions zero/empty screenshots', async () => {
    const f = createDeliveryFixture();
    f.validating();
    f.passCaptured.handleDeletionGuardError = vi.fn(() => true);
    vi.mocked(f.worktreeManager.mergeBranch).mockRejectedValueOnce(new Error('synthetic guard'));
    await expect(
      f.repass().completeRevalidationPass.call(f.calls, {
        ...f.passContext(),
        revalDefaultBranch: 'main',
        newCommits: false,
      }),
    ).resolves.toEqual({ newCommits: false, result: 'pass' });
    expect(f.worktreeManager.mergeBranch).toHaveBeenCalledWith(
      expect.objectContaining({ maxDeletions: 0 }),
    );
    expect(f.provider.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ screenshots: [], filesChanged: 3 }),
    );
    expect(f.pod().status).toBe('validated');
  });
  it('rethrows credential identity without invoking trigger credential parking', async () => {
    const f = createDeliveryFixture();
    f.validating();
    const error = new GitCredentialError('synthetic', 'github', 'push', 'synthetic');
    vi.mocked(f.worktreeManager.mergeBranch).mockRejectedValueOnce(error);
    await expect(
      f.repass().completeRevalidationPass.call(f.calls, {
        ...f.passContext(),
        revalDefaultBranch: 'main',
        newCommits: true,
      }),
    ).rejects.toBe(error);
    expect(f.pod().status).toBe('validating');
    expect(f.pod().pendingEscalation).toBeNull();
    expect(f.provider.createPr).not.toHaveBeenCalled();
  });
  it('keeps existing PR identity, tolerates new PR failure and defers dynamic approval', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    f.validating();
    f.podRepo.update('prepare', {
      prUrl: 'https://github.com/org/repo/pull/27',
      autoApprove: true,
    });
    await f.repass().completeRevalidationPass.call(f.calls, {
      ...f.passContext(),
      revalDefaultBranch: 'main',
      newCommits: true,
    });
    expect(f.provider.createPr).not.toHaveBeenCalled();
    const replacement = vi.fn(async () => {});
    f.calls.approveSession = replacement;
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement).toHaveBeenCalledWith('prepare', { automation: true });
    f.validating();
    f.podRepo.update('prepare', { prUrl: null, autoApprove: false });
    f.provider.createPr.mockRejectedValueOnce(new Error('synthetic create'));
    await expect(
      f.repass().completeRevalidationPass.call(f.calls, {
        ...f.passContext(),
        revalDefaultBranch: 'main',
        newCommits: true,
      }),
    ).resolves.toEqual({ newCommits: true, result: 'pass' });
    expect(f.pod()).toMatchObject({ status: 'validated', prUrl: null });
  });
});
