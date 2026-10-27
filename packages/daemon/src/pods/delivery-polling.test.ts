import { describe, expect, it, vi } from 'vitest';
import { createDeliveryFixture, pendingStatus } from '../test-utils/delivery-helpers.js';
import { createDeliveryPolling } from './delivery-polling.js';

describe('owned merge polling', () => {
  it('resumes only merge_pending rows with the bound profile interval and stops a missing history', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    f.mergePending();
    f.profiles.update('test-profile', { mergePollIntervalSec: 7 });
    const start = vi.spyOn(f.state.mergePolling, 'start');
    f.polling().resumeMergePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledWith('prepare', 7_000, expect.any(Function));
    expect(f.pod().status).toBe('failed');
    expect(f.pod().failureReason).toContain('Delivery history is unavailable');
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.provider.getPrStatus).not.toHaveBeenCalled();
  });
  it('stops immediately when the bound provider is absent', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    f.mergePending();
    const poll = createDeliveryPolling({ ...f.pollingCaptured, prManagerFactory: () => null });
    poll.startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.provider.getPrStatus).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('merge_pending');
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
  });
  it('retains closed PR source and stops without push, rebase or cleanup', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    const planned = await f.planMerge();
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({
        open: false,
        headSha: planned.publication.commitSha,
        sourceTarget: {
          repository: planned.publication.repository,
          branch: 'branch',
          baseBranch: 'main',
        },
      }),
    );
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().status).toBe('failed');
    expect(f.pod().failureReason).toContain('PR closed without merging');
    expect(f.pod().containerId).toBe('container-123');
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.provider.getPrStatus).toHaveBeenCalledOnce();
  });
  it('waits for review, then admits only the retained source through the shared merge queue', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    const planned = await f.planMerge();
    f.provider.getPrStatus.mockResolvedValue(pendingStatus({ reviewDecision: 'REVIEW_REQUIRED' }));
    const queue = vi.spyOn(f.queue.mergeQueue, 'enqueueMerge');
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    f.provider.getPrStatus.mockResolvedValue(pendingStatus({ reviewDecision: 'APPROVED' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queue).toHaveBeenCalledWith('https://github.com/org/repo', 'main', expect.any(Function));
    expect(f.provider.mergePr).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedHeadSha: planned.publication.commitSha,
        expectedTarget: {
          repository: planned.publication.repository,
          branch: 'branch',
          baseBranch: 'main',
        },
      }),
    );
    expect(f.podRepo.mergeJournal?.find(f.pod())?.state).toBe('pending');
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.worktreeManager.rebaseOntoBase).not.toHaveBeenCalled();
  });
  it('deduplicates actionable feedback while still consulting the canonical fix lifecycle', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    await f.planMerge();
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({
        reviewDecision: 'CHANGES_REQUESTED',
        reviewComments: [{ body: 'Synthetic repair', path: null }],
      }),
    );
    const enqueue = vi.spyOn(f.deps.fixFeedbackRepo, 'enqueue');
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(f.pollingCaptured.maybeSpawnFixSession).toHaveBeenCalledTimes(2);
    expect(f.provider.mergePr).not.toHaveBeenCalled();
  });
  it('dispatches build repairs while reviewer and policy gates still block merging', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    await f.planMerge();
    const status = pendingStatus({
      mergeBlocked: true,
      reviewDecision: 'REVIEW_REQUIRED',
      blockReason: 'Build failed; waiting for reviewer',
      ciFailures: [{ name: 'Build', conclusion: 'failure', detailsUrl: null, annotations: [] }],
    });
    f.provider.getPrStatus.mockResolvedValue(status);
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pollingCaptured.maybeSpawnFixSession).toHaveBeenCalledWith('prepare', status);
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.pod().status).toBe('merge_pending');
  });

  it('does not dispatch a source-changing repair over an unresolved admitted merge', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    const planned = await f.planMerge();
    f.podRepo.mergeJournal?.claim(
      f.pod(),
      f.pod(),
      planned.publication.publicationId,
      planned.entry.request.config,
    );
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({
        mergeBlocked: true,
        ciFailures: [{ name: 'Build', conclusion: 'failure', detailsUrl: null, annotations: [] }],
      }),
    );
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.pollingCaptured.maybeSpawnFixSession).not.toHaveBeenCalled();
    expect(f.pod().mergeBlockReason).toContain('reconciliation');
    expect(f.podRepo.mergeJournal?.find(f.pod())?.state).toBe('admitted');
  });

  it('does not change an already-planned merge method when branch policy changes', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    await f.planMerge();
    f.provider.getPrStatus.mockResolvedValue(pendingStatus({ squashRequired: true }));
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.pod().mergeBlockReason).toBe('Branch policy requires squash merge');
    expect(f.podRepo.mergeJournal?.find(f.pod())?.request.config.squash).toBe(false);
  });

  it('waits without merging or spawning fixes for administrative blockers', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    await f.planMerge();
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({
        mergeBlocked: true,
        blockReason: 'Required work item missing',
      }),
    );
    f.polling().startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.pollingCaptured.maybeSpawnFixSession).not.toHaveBeenCalled();
    expect(f.pod().mergeBlockReason).toBe('Required work item missing');
  });

  it('fences a stopped owner while provider status is in flight', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture();
    const planned = await f.planMerge();
    let release = (_: ReturnType<typeof pendingStatus>) => {};
    const gate = new Promise<ReturnType<typeof pendingStatus>>((resolve) => {
      release = resolve;
    });
    f.provider.getPrStatus.mockReturnValueOnce(gate);
    const poll = f.polling();
    poll.startMergePolling('prepare');
    await vi.advanceTimersByTimeAsync(0);
    poll.stopMergePolling('prepare');
    release(
      pendingStatus({
        merged: true,
        open: false,
        headSha: planned.publication.commitSha,
        sourceTarget: {
          repository: planned.publication.repository,
          branch: 'branch',
          baseBranch: 'main',
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.pod().status).toBe('merge_pending');
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(f.mainCaptured.maybeTriggerDependents).not.toHaveBeenCalled();
  });
  it('restarts a real SQLite merge intent and retains review-blocked resources across reopen', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture(true);
    const planned = await f.planMerge();
    const original = f.pod();
    const profile = f.profiles.get('test-profile');
    const restart = f.reopenPolling();
    f.provider.getPrStatus.mockResolvedValue(pendingStatus({ reviewDecision: 'REVIEW_REQUIRED' }));
    restart.poll.resumeMergePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.provider.getPrStatus).toHaveBeenCalledOnce();
    expect(restart.next.pods.getOrThrow('prepare')).toEqual({
      ...original,
      mergeBlockReason: 'Waiting',
    });
    expect(restart.next.pods.mergeJournal?.find(original)?.publicationId).toBe(
      planned.publication.publicationId,
    );
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.pollingCaptured.cleanupContainer).not.toHaveBeenCalled();
    expect(restart.next.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it.each(['different source', 'missing worktree'] as const)(
    'requires provider source proof, not a disposable checkout, for a merged PR with %s',
    async (failure) => {
      vi.useFakeTimers();
      const f = createDeliveryFixture(true);
      const planned = await f.planMerge();
      const restart = f.reopenPolling();
      vi.mocked(f.worktreeManager.pushBranch).mockClear();
      const events: string[] = [];
      restart.captured.eventBus.subscribe((event) => events.push(event.type));
      f.provider.getPrStatus.mockResolvedValue(
        pendingStatus({
          merged: true,
          open: false,
          headSha: failure === 'different source' ? 'f'.repeat(40) : planned.publication.commitSha,
          sourceTarget: {
            repository: planned.publication.repository,
            branch: 'branch',
            baseBranch: 'main',
          },
        }),
      );
      if (failure === 'missing worktree') {
        if (!f.worktreeManager.inspectSource) throw new Error('Missing source inspector');
        vi.mocked(f.worktreeManager.inspectSource).mockRejectedValueOnce(
          new Error('spawn git ENOENT'),
        );
      }
      restart.poll.resumeMergePolling();
      await vi.advanceTimersByTimeAsync(0);
      const result = restart.next.pods.getOrThrow('prepare');
      expect(result.status).toBe(failure === 'different source' ? 'merge_pending' : 'complete');
      if (failure === 'different source') {
        expect(result.mergeBlockReason).toContain(
          'PR source does not match the confirmed published commit',
        );
        expect(restart.captured.maybeTriggerDependents).not.toHaveBeenCalled();
        expect(events).not.toContain('pod.completed');
      } else {
        expect(result.mergeBlockReason).toBeNull();
        expect(restart.captured.maybeTriggerDependents).toHaveBeenCalledOnce();
        expect(events).toContain('pod.completed');
      }
      expect(result.containerId).toBe('container-123');
      expect(result.worktreePath).toBeTruthy();
      expect(restart.captured.cleanupContainer).not.toHaveBeenCalled();
      expect(f.provider.mergePr).not.toHaveBeenCalled();
      expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.provider.getPrStatus).toHaveBeenCalledTimes(failure === 'different source' ? 3 : 1);
      restart.poll.stopMergePolling('prepare');
      const final = f.reopen();
      expect(final.pods.getOrThrow('prepare')).toEqual(result);
    },
  );

  it('confirms a source-bound merge after SQLite restart before cleanup/completion/dependents', async () => {
    vi.useFakeTimers();
    const f = createDeliveryFixture(true);
    const planned = await f.planMerge();
    const restart = f.reopenPolling();
    const events: string[] = [];
    restart.captured.eventBus.subscribe((e) => {
      events.push(e.type);
    });
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({
        merged: true,
        open: false,
        headSha: planned.publication.commitSha,
        sourceTarget: {
          repository: planned.publication.repository,
          branch: 'branch',
          baseBranch: 'main',
        },
      }),
    );
    restart.poll.resumeMergePolling();
    await vi.advanceTimersByTimeAsync(0);
    const completed = restart.next.pods.getOrThrow('prepare');
    expect(completed.status).toBe('complete');
    expect(
      f.db
        .prepare(
          'SELECT disposition, evidence FROM merge_disposition_observations WHERE intent_id=?',
        )
        .get(planned.entry.id),
    ).toEqual({ disposition: 'merged', evidence: 'provider_lookup' });
    expect(restart.captured.cleanupContainer).toHaveBeenCalledOnce();
    expect(events).toContain('pod.completed');
    expect(restart.captured.maybeTriggerDependents).toHaveBeenCalledWith(completed);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.provider.getPrStatus).toHaveBeenCalledOnce();
    restart.poll.stopMergePolling('prepare');
    const stored = f.db
      .prepare('SELECT * FROM merge_disposition_observations WHERE intent_id=?')
      .get(planned.entry.id);
    const history = f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare');
    const profile = restart.next.profiles.get('test-profile');
    const final = f.reopen();
    expect(final.pods.getOrThrow('prepare')).toEqual(completed);
    expect(
      f.db
        .prepare('SELECT * FROM merge_disposition_observations WHERE intent_id=?')
        .get(planned.entry.id),
    ).toEqual(stored);
    expect(f.db.prepare('SELECT * FROM events WHERE pod_id=? ORDER BY id').all('prepare')).toEqual(
      history,
    );
    expect(final.profiles.get('test-profile')).toEqual(profile);
    expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});
