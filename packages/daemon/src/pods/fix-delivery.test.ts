import { describe, expect, it, vi } from 'vitest';
import { createFixCycleFixture } from '../test-utils/fix-cycle-helpers.js';
import { mockFixBranchPublication } from '../test-utils/mock-helpers.js';

async function fixture(disk = false) {
  const f = createFixCycleFixture(disk);
  await f.planMerge();
  vi.mocked(f.worktreeManager.pushBranch).mockClear().mockImplementation(mockFixBranchPublication);
  return f;
}
import { createFixDelivery } from './fix-delivery.js';
describe('validated fix delivery leaves parent merge ownership intact', () => {
  it('refuses queued fix rebase after immutable task custody arrives', async () => {
    const f = await fixture();
    f.insertFix();
    f.podRepo.update('fix-child', { containerId: null });
    f.podRepo.update('fix-child', {
      executionTarget: 'sandbox',
      containerId: '11111111-1111-4111-8111-111111111111',
    });
    const fix = f.fix();
    let release = () => {};
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = f.queue.mergeQueue.enqueueMerge(
      'https://github.com/org/repo',
      'main',
      async () => {
        entered();
        await gate;
      },
    );
    await waiting;
    const delivery = f.delivery().completeFixPodAfterPush(fix);
    const retries = f.podRepo.taskRetries;
    const ledger = f.podRepo.validationExecutions;
    if (!retries || !ledger) throw new Error('Missing durable validation ledger');
    const identity = {
      source: 'a'.repeat(64),
      contract: 'b'.repeat(64),
      commands: 'c'.repeat(64),
      environment: null,
      implementation: null,
    };
    const admission = retries.admit(fix.id, fix.lifecycleGeneration, identity, 'd'.repeat(64), []);
    retries.start(admission.id);
    expect(ledger.dispatch(fix, admission.id, 1, 'test-scope')).not.toBeNull();
    release();
    await blocker;
    await delivery;
    expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.admissionCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.fix().containerId).toBe(fix.containerId);
  });

  it('force-pushes with explicit credentials, replies only afterward and persists completion/history across reopen', async () => {
    const f = await fixture(true);
    const fix = f.insertFix();
    const replies = vi.fn(async () => {});
    await createFixDelivery({
      ...f.deliveryCaptured,
      postFixPodReviewFeedbackReplies: replies,
    }).completeFixPodAfterPush(fix);
    expect(f.worktreeManager.pushBranch).toHaveBeenCalledWith(
      f.directory,
      'branch',
      expect.objectContaining({
        force: true,
        pat: 'synthetic-git-key',
        expectedRepository: 'https://github.com/org/repo',
        onPrepared: expect.any(Function),
      }),
    );
    expect(vi.mocked(f.worktreeManager.pushBranch).mock.invocationCallOrder[0]).toBeLessThan(
      replies.mock.invocationCallOrder[0] ?? 0,
    );
    expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: 'fix-child' }));
    expect(f.fix().status).toBe('complete');
    expect(f.pod().status).toBe('merge_pending');
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    const saved = f.fix();
    const parent = f.pod();
    const events = f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('fix-child');
    expect(events.length).toBeGreaterThan(0);
    const next = f.reopen();
    expect(next.pods.getOrThrow('fix-child')).toEqual(saved);
    expect(next.pods.getOrThrow('prepare')).toEqual(parent);
    expect(
      f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('fix-child'),
    ).toEqual(events);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('skips delivery for an already completed parent but retains the original fix completion path', async () => {
    const f = await fixture();
    const fix = f.insertFix();
    f.podRepo.update('prepare', { status: 'complete' });
    await f.delivery().completeFixPodAfterPush(fix);
    expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.fix().status).toBe('complete');
  });
  it('shares the actual merge queue and rechecks a parent that becomes terminal while waiting', async () => {
    const f = await fixture();
    const fix = f.insertFix();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = f.queue.mergeQueue.enqueueMerge(
      'https://github.com/org/repo',
      'main',
      async () => {
        await gate;
      },
    );
    const delivery = f.delivery().completeFixPodAfterPush(fix);
    await Promise.resolve();
    expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
    f.podRepo.update('prepare', { status: 'killed' });
    release();
    await Promise.all([blocker, delivery]);
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.fix().status).toBe('complete');
  });
  it('rechecks terminal parent identity after rebase before publishing', async () => {
    const f = await fixture();
    const fix = f.insertFix();
    vi.mocked(f.worktreeManager.rebaseOntoBase).mockImplementationOnce(async () => {
      f.podRepo.update('prepare', { status: 'complete' });
      return { rebased: true, alreadyUpToDate: false, conflicts: [] };
    });
    await f.delivery().completeFixPodAfterPush(fix);
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.fix().status).toBe('complete');
  });
  it('completes a conflicting fix without force-push or review replies', async () => {
    const f = await fixture();
    const fix = f.insertFix();
    const replies = vi.fn(async () => {});
    vi.mocked(f.worktreeManager.rebaseOntoBase).mockResolvedValueOnce({
      rebased: false,
      alreadyUpToDate: false,
      conflicts: ['a.ts'],
    });
    await createFixDelivery({
      ...f.deliveryCaptured,
      postFixPodReviewFeedbackReplies: replies,
    }).completeFixPodAfterPush(fix);
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(replies).not.toHaveBeenCalled();
    expect(f.fix().status).toBe('complete');
  });
  it('parks failed delivery without cleanup or merging the parent PR', async () => {
    const f = await fixture();
    const fix = f.insertFix();
    vi.mocked(f.worktreeManager.pushBranch).mockRejectedValueOnce(
      new Error('synthetic rejected push'),
    );
    await f.delivery().completeFixPodAfterPush(fix);
    expect(f.fix()).toMatchObject({
      status: 'awaiting_input',
      containerId: 'fix-container',
      worktreePath: f.directory,
    });
    expect(f.admissionCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('merge_pending');
  });
});
