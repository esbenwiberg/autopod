import { describe, expect, it, vi } from 'vitest';
import { createFixCycleFixture, pendingStatus } from '../test-utils/fix-cycle-helpers.js';
import { type MergedFixRecoveryInput, recoverMergedFix } from './merged-fix-recovery.js';

async function fixture() {
  const f = createFixCycleFixture(true);
  const repository = 'https://dev.azure.com/org/project/_git/repo';
  const prUrl = `${repository}/pullrequest/27`;
  const original = await f.planMerge({ repository, prUrl });
  const fix = f.insertFix();
  f.podRepo.update(fix.id, { status: 'complete' });
  const input: MergedFixRecoveryInput = {
    podId: 'prepare',
    fixPodId: fix.id,
    actor: 'operator',
    reason: 'Verified the merged fix delivers the original task.',
    sourcePath: f.directory,
    local: {
      repository,
      branch: 'branch',
      remoteRef: 'refs/heads/branch',
      commitSha: 'c'.repeat(40),
      treeSha: 'd'.repeat(40),
      worktreeClean: true,
    },
    evidence: {
      observedAt: new Date().toISOString(),
      prUrl,
      pr: {
        pullRequestId: 27,
        status: 'completed',
        mergeStatus: 'succeeded',
        sourceRefName: 'refs/heads/branch',
        targetRefName: 'refs/heads/main',
        lastMergeSourceCommit: { commitId: 'c'.repeat(40) },
        repository: { webUrl: repository },
      },
    },
  };
  return { f, input, original };
}

describe('explicit legacy merged-fix recovery', () => {
  it('dry-runs without publishing evidence, then preserves the old journal and lets polling complete', async () => {
    vi.useFakeTimers();
    const { f, input, original } = await fixture();
    expect(recoverMergedFix(f.db, input, false).applied).toBe(false);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM fix_source_handoffs').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_publication_receipts').get()).toEqual({
      n: 1,
    });
    expect(recoverMergedFix(f.db, input, true).applied).toBe(true);
    expect(f.pod().status).toBe('merge_pending');
    expect(
      f.db.prepare('SELECT id FROM merge_intents WHERE id = ?').get(original.entry.id),
    ).toEqual({ id: original.entry.id });
    const audit = f.db.prepare('SELECT recovery FROM fix_source_handoffs').get() as {
      recovery: string;
    };
    expect(JSON.parse(audit.recovery)).toMatchObject({
      actor: 'operator',
      reason: input.reason,
      evidence: JSON.stringify(input.evidence),
    });
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    const restart = f.reopenPolling();
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({
        merged: true,
        open: false,
        headSha: input.local.commitSha,
        sourceTarget: original.entry.request.config.expectedTarget,
      }),
    );
    restart.poll.resumeMergePolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart.next.pods.getOrThrow('prepare').status).toBe('complete');
    expect(restart.captured.maybeTriggerDependents).toHaveBeenCalledOnce();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([
    'stale evidence',
    'wrong source',
    'wrong target',
    'wrong PR',
    'dirty source',
    'open PR',
    'fork',
    'unlinked fix',
    'active fix',
    'ambiguous merge',
    'missing actor',
    'replaced parent',
  ] as const)('refuses %s without creating handoff evidence', async (failure) => {
    const { f, input, original } = await fixture();
    if (failure === 'stale evidence')
      input.evidence.observedAt = new Date(Date.now() - 180_000).toISOString();
    if (failure === 'wrong source') input.local.commitSha = 'e'.repeat(40);
    if (failure === 'wrong target') input.evidence.pr.targetRefName = 'refs/heads/other';
    if (failure === 'wrong PR') input.evidence.pr.pullRequestId = 28;
    if (failure === 'dirty source') input.local.worktreeClean = false;
    if (failure === 'open PR') input.evidence.pr.status = 'active';
    if (failure === 'fork') input.evidence.pr.forkSource = {};
    if (failure === 'unlinked fix') f.podRepo.update('prepare', { fixPodId: null });
    if (failure === 'active fix') f.podRepo.update(input.fixPodId, { status: 'running' });
    if (failure === 'missing actor') input.actor = '';
    if (failure === 'replaced parent') f.podRepo.incrementLifecycleGeneration('prepare');
    if (failure === 'ambiguous merge')
      f.podRepo.mergeJournal?.claim(
        f.pod(),
        f.pod(),
        original.publication.publicationId,
        original.entry.request.config,
      );
    expect(() => recoverMergedFix(f.db, input, true)).toThrow();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM fix_source_handoffs').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_publication_receipts').get()).toEqual({
      n: 1,
    });
    expect(f.provider.mergePr).not.toHaveBeenCalled();
  });
});
