import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture, pendingStatus } from '../test-utils/delivery-helpers.js';
import { reconcileMerge } from '../worktrees/durable-merge.js';
import { createDurablePrManagerFactory } from '../worktrees/durable-pr-manager.js';
import { createDeliveryLedger } from './delivery-ledger.js';

async function fixture() {
  const f = createDeliveryFixture(true);
  f.prCaptured.prManagerFactory.mockImplementation((profile) =>
    createDurablePrManagerFactory(createDeliveryLedger(f.db), () => f.provider)(profile),
  );
  const original = await f.planMerge();
  const status = pendingStatus({
    merged: true,
    open: false,
    headSha: 'c'.repeat(40),
    sourceTarget: original.entry.request.config.expectedTarget,
  });
  const proof = {
    publishedHeadSha: original.publication.commitSha,
    mergedHeadSha: 'c'.repeat(40),
    target: original.entry.request.config.expectedTarget,
    observedAt: new Date().toISOString(),
  };
  f.provider.getPrStatus.mockResolvedValue(status);
  f.provider.verifyMergedSourceAncestry.mockResolvedValue(proof);
  return { f, original, status, proof };
}

describe('completion after a human extends and merges a published PR', () => {
  it('completes a merged descendant even with a missing checkout, without rewriting publication or claiming our merge succeeded', async () => {
    vi.useFakeTimers();
    const { f, original, proof } = await fixture();
    const inspect = f.worktreeManager.inspectSource;
    if (!inspect) throw new Error('Missing inspector');
    vi.mocked(inspect).mockRejectedValue(new Error('spawn git ENOENT'));
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().status).toBe('complete');
    expect(f.pollingCaptured.maybeTriggerDependents).toHaveBeenCalledOnce();
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM merge_attempts').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM merge_observations').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM merge_disposition_observations').get()).toEqual({
      n: 0,
    });
    const observed = f.db
      .prepare('SELECT ancestry, result FROM merge_external_observations WHERE intent_id = ?')
      .get(original.entry.id) as { ancestry: string; result: string };
    expect(JSON.parse(observed.ancestry)).toEqual(proof);
    expect(JSON.parse(observed.result).source.headSha).toBe(proof.mergedHeadSha);
    const receipt = f.podRepo.sourcePublications?.get(original.publication.publicationId);
    expect(receipt?.receipt?.commitSha).toBe(original.publication.commitSha);
    expect(f.podRepo.taskExecutions?.snapshot('prepare').merge).toMatchObject({
      mergedPrCount: 1,
      unresolvedPrCount: 0,
      requestCount: 0,
      mergedWithoutRecordedRequestCount: 1,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.provider.getPrStatus).toHaveBeenCalledOnce();
  });

  it('replays durable external evidence after restart without another ancestry lookup', async () => {
    vi.useFakeTimers();
    const { f, original, status, proof } = await fixture();
    const journal = f.podRepo.mergeJournal;
    if (!journal) throw new Error('Missing journal');
    const result = await reconcileMerge(journal, f.pod(), original.entry, f.provider, status);
    expect(result.source?.headSha).toBe(proof.mergedHeadSha);
    expect(journal.find(f.pod())?.request.config.expectedHeadSha).toBe(
      original.publication.commitSha,
    );
    const restart = f.reopenPolling();
    restart.poll.resumeMergePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart.next.pods.getOrThrow('prepare').status).toBe('complete');
    expect(f.provider.verifyMergedSourceAncestry).toHaveBeenCalledOnce();
    expect(restart.captured.cleanupContainer).toHaveBeenCalledOnce();
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([
    'no proof',
    'wrong ancestor',
    'wrong descendant',
    'wrong target',
    'different repository',
    'lookup error',
    'open PR',
  ] as const)('does not complete or mutate the PR for %s', async (failure) => {
    vi.useFakeTimers();
    const { f, status, proof } = await fixture();
    if (failure === 'no proof') f.provider.verifyMergedSourceAncestry.mockResolvedValue(null);
    if (failure === 'wrong ancestor')
      f.provider.verifyMergedSourceAncestry.mockResolvedValue({
        ...proof,
        publishedHeadSha: 'e'.repeat(40),
      });
    if (failure === 'wrong descendant')
      f.provider.verifyMergedSourceAncestry.mockResolvedValue({
        ...proof,
        mergedHeadSha: 'e'.repeat(40),
      });
    if (failure === 'wrong target')
      f.provider.verifyMergedSourceAncestry.mockResolvedValue({
        ...proof,
        target: { ...proof.target, baseBranch: 'other' },
      });
    if (failure === 'different repository')
      f.provider.getPrStatus.mockResolvedValue({
        ...status,
        sourceTarget: { ...proof.target, repository: 'https://github.com/org/other' },
      });
    if (failure === 'lookup error')
      f.provider.verifyMergedSourceAncestry.mockRejectedValue(new Error('provider unavailable'));
    if (failure === 'open PR')
      f.provider.getPrStatus.mockResolvedValue({ ...status, merged: false, open: true });
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().status).toBe('merge_pending');
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.pollingCaptured.maybeTriggerDependents).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM merge_external_observations').get()).toEqual({
      n: 0,
    });
    if (failure === 'open PR' || failure === 'different repository')
      expect(f.provider.verifyMergedSourceAncestry).not.toHaveBeenCalled();
  });

  it('fences completion if the lifecycle changes during ancestry lookup', async () => {
    vi.useFakeTimers();
    const { f, proof } = await fixture();
    f.provider.verifyMergedSourceAncestry.mockImplementationOnce(async () => {
      f.podRepo.incrementLifecycleGeneration('prepare');
      return proof;
    });
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().status).toBe('merge_pending');
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.pollingCaptured.maybeTriggerDependents).not.toHaveBeenCalled();
  });
});
