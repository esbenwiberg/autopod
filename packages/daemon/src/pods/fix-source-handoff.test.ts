import { describe, expect, it, vi } from 'vitest';
import { createFixCycleFixture, pendingStatus } from '../test-utils/fix-cycle-helpers.js';
import { mockFixBranchPublication } from '../test-utils/mock-helpers.js';

async function fixture() {
  const f = createFixCycleFixture(true);
  const original = await f.planMerge();
  const fix = f.insertFix();
  vi.mocked(f.worktreeManager.pushBranch).mockClear().mockImplementation(mockFixBranchPublication);
  const merged = pendingStatus({
    merged: true,
    open: false,
    headSha: 'c'.repeat(40),
    sourceTarget: original.entry.request.config.expectedTarget,
  });
  return { f, fix, original, merged };
}

describe('fix publication ownership and merge completion', () => {
  it('hands off a changed commit, merges it with the original method, and completes across restart', async () => {
    vi.useFakeTimers();
    const { f, fix, original, merged } = await fixture();
    await f.delivery().completeFixPodAfterPush(fix);
    expect(f.fix().status).toBe('complete');
    const entry = f.podRepo.mergeJournal?.find(f.pod());
    expect(entry?.publicationId).not.toBe(original.publication.publicationId);
    expect(entry?.request.config).toEqual({
      ...original.entry.request.config,
      expectedHeadSha: 'c'.repeat(40),
    });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM merge_intents').get()).toEqual({ n: 2 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_publication_receipts').get()).toEqual({
      n: 2,
    });
    // The parent's checkout still has the original SHA, not the fix's commit.
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.mergePr).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: 'c'.repeat(40), squash: false }),
    );
    f.polling().stopMergePolling('prepare');
    const restart = f.reopenPolling();
    f.provider.getPrStatus.mockResolvedValue(merged);
    restart.poll.resumeMergePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart.next.pods.getOrThrow('prepare').status).toBe('complete');
    expect(restart.captured.maybeTriggerDependents).toHaveBeenCalledOnce();
    // A stale local checkout is retained, not used to veto a proven delivery.
    expect(restart.captured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each(['receipt', 'plan'] as const)(
    'recovers a crash before %s without pushing or merging again',
    async (window) => {
      vi.useFakeTimers();
      const { f, fix, original, merged } = await fixture();
      if (window === 'receipt') {
        vi.mocked(f.worktreeManager.pushBranch).mockImplementationOnce(async (...args) => {
          await mockFixBranchPublication(...args);
          throw new Error('push result lost');
        });
      } else {
        const journal = f.podRepo.mergeJournal;
        if (!journal) throw new Error('Missing journal');
        const plan = journal.plan.bind(journal);
        vi.spyOn(journal, 'plan').mockImplementation((...args) => {
          if (args[2] !== original.publication.publicationId)
            throw new Error('crash before planning');
          return plan(...args);
        });
      }
      await f.delivery().completeFixPodAfterPush(fix);
      expect(f.fix().status).toBe('awaiting_input');
      expect(f.podRepo.sourcePublications?.fixForMerge(f.pod())?.confirmed).toBe(window === 'plan');
      const restart = f.reopenPolling();
      f.provider.getPrStatus.mockResolvedValue(merged);
      restart.poll.resumeMergePolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(restart.next.pods.getOrThrow('prepare').status).toBe('complete');
      expect(f.provider.mergePr).not.toHaveBeenCalled();
      expect(f.worktreeManager.pushBranch).toHaveBeenCalledOnce();
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_publication_receipts').get()).toEqual({
        n: 2,
      });
    },
  );

  it('does not adopt an ambiguous push from a different provider source', async () => {
    vi.useFakeTimers();
    const { f, fix, original, merged } = await fixture();
    vi.mocked(f.worktreeManager.pushBranch).mockImplementationOnce(async (...args) => {
      await mockFixBranchPublication(...args);
      throw new Error('push result lost');
    });
    await f.delivery().completeFixPodAfterPush(fix);
    f.provider.getPrStatus.mockResolvedValue({ ...merged, headSha: 'e'.repeat(40) });
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().status).toBe('merge_pending');
    expect(f.podRepo.mergeJournal?.find(f.pod())?.id).toBe(original.entry.id);
    expect(f.podRepo.sourcePublications?.fixForMerge(f.pod())?.confirmed).toBe(false);
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
  });

  it.each(['admitted', 'scheduled'] as const)(
    'refuses a fix push over an %s merge request',
    async (state) => {
      const { f, fix, original } = await fixture();
      const journal = f.podRepo.mergeJournal;
      if (!journal) throw new Error('Missing journal');
      const attempt = journal.claim(
        f.pod(),
        f.pod(),
        original.publication.publicationId,
        original.entry.request.config,
      );
      if (state === 'scheduled')
        journal.observe(attempt, { merged: false, autoMergeScheduled: true }, 'merge_response');
      await f.delivery().completeFixPodAfterPush(fix);
      expect(f.fix().status).toBe('awaiting_input');
      expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
      expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
      expect(f.podRepo.sourcePublications?.fixForMerge(f.pod())).toBeNull();
    },
  );

  it('fences an old status lookup when a fix publishes while the lookup is in flight', async () => {
    vi.useFakeTimers();
    const { f, fix, original, merged } = await fixture();
    let release = (_: typeof merged) => {};
    f.provider.getPrStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    await f.delivery().completeFixPodAfterPush(fix);
    release({ ...merged, headSha: original.publication.commitSha });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().status).toBe('merge_pending');
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    f.provider.getPrStatus.mockResolvedValue(merged);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.pod().status).toBe('complete');
  });

  it('does not merge the old source while a new fix is still running', async () => {
    vi.useFakeTimers();
    const { f } = await fixture();
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('merge_pending');
  });

  it('allows a recycled fix to republish the same confirmed source without rewriting its origin', async () => {
    const { f, fix } = await fixture();
    await f.delivery().completeFixPodAfterPush(fix);
    const first = f.podRepo.sourcePublications?.fixForMerge(f.pod());
    f.podRepo.incrementLifecycleGeneration(fix.id);
    f.podRepo.update(fix.id, { status: 'validated' });
    const recycled = f.fix();
    f.podRepo.completionJournal?.begin(recycled);
    f.podRepo.completionJournal?.mark(recycled, 'finalizing');
    await f.delivery().completeFixPodAfterPush(recycled);
    expect(f.fix().status).toBe('complete');
    expect(f.podRepo.sourcePublications?.fixForMerge(f.pod())).toEqual(first);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_publication_receipts').get()).toEqual({
      n: 2,
    });
  });

  it('refuses a stale fix lifecycle before the push can execute', async () => {
    const { f, fix } = await fixture();
    let pushed = false;
    vi.mocked(f.worktreeManager.pushBranch).mockImplementationOnce(async (...args) => {
      f.podRepo.incrementLifecycleGeneration(fix.id);
      const result = await mockFixBranchPublication(...args);
      pushed = true;
      return result;
    });
    await f.delivery().completeFixPodAfterPush(fix);
    expect(pushed).toBe(false);
    expect(f.podRepo.sourcePublications?.fixForMerge(f.pod())).toBeNull();
  });
});
