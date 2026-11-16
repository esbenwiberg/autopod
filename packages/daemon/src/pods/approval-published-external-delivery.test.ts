import { describe, expect, it } from 'vitest';
import { createDeliveryFixture, pendingStatus } from '../test-utils/delivery-helpers.js';
import { publishSource } from '../worktrees/durable-source-publication.js';
import { createApprovalDeliveryExecution } from './approval-delivery-execution.js';
import { createApprovalDeliveryPreparation } from './approval-delivery-preparation.js';
import { createApprovalWorkflow } from './approval-workflow.js';

async function fixture(beforePr = false) {
  const f = createDeliveryFixture();
  const url = 'https://github.com/org/repo/pull/27';
  if (!beforePr) f.podRepo.update('prepare', { prUrl: url });
  const ledger = f.podRepo.sourcePublications;
  if (!ledger) throw new Error('Missing publication ledger');
  const publication = await publishSource(
    ledger,
    f.pod(),
    'https://github.com/org/repo',
    f.worktreeManager,
  );
  f.podRepo.update('prepare', { prUrl: url });
  const target = {
    repository: publication.repository,
    branch: publication.branch,
    baseBranch: 'main',
  };
  f.provider.getPrStatus.mockResolvedValue(
    pendingStatus({
      merged: true,
      open: false,
      headSha: publication.commitSha,
      sourceTarget: target,
    }),
  );
  const captured = { ...f.mainCaptured, prManagerFactory: () => f.provider };
  const workflow = createApprovalWorkflow({
    ...captured,
    ...createApprovalDeliveryPreparation(captured),
    ...createApprovalDeliveryExecution(captured),
  });
  f.worktreeManager.pushBranch.mockClear();
  const approve = (squash?: boolean) =>
    workflow.approveSession('prepare', {
      ...(squash !== undefined ? { squash } : {}),
      actor: { type: 'human', userId: 'operator' },
      reason: 'Reconcile the provider-confirmed external delivery.',
    });
  return { ...f, publication, target, approve, workflow };
}

describe('human approval of published local PRs merged externally', () => {
  it.each([
    false,
    true,
  ])('completes without another publication or merge (publication before PR: %s)', async (beforePr) => {
    const f = await fixture(beforePr);
    await f.approve();
    expect(f.pod().status).toBe('complete');
    expect(f.db.prepare('SELECT publication_id AS id FROM merge_intents').get()).toEqual({
      id: f.publication.publicationId,
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM merge_disposition_observations').get()).toEqual({
      n: 1,
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 0 });
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.worktreeManager.mergeBranch).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).toHaveBeenCalledOnce();
  });

  it('records provider-proven descendant delivery without validating the additional commits', async () => {
    const f = await fixture(true);
    const head = 'c'.repeat(40);
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({ merged: true, open: false, headSha: head, sourceTarget: f.target }),
    );
    f.provider.verifyMergedSourceAncestry.mockResolvedValue({
      publishedHeadSha: f.publication.commitSha,
      mergedHeadSha: head,
      target: f.target,
      observedAt: new Date().toISOString(),
    });
    await f.approve();
    expect(f.pod().status).toBe('complete');
    expect(f.db.prepare('SELECT count(*) AS n FROM merge_external_observations').get()).toEqual({
      n: 1,
    });
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
  });

  it('preserves the requested squash method across an uncertain read and approval retry', async () => {
    const f = await fixture(true);
    const head = 'c'.repeat(40);
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({ merged: true, open: false, headSha: head, sourceTarget: f.target }),
    );
    f.provider.verifyMergedSourceAncestry.mockRejectedValueOnce(new Error('Read unavailable'));
    await expect(f.approve(true)).rejects.toBeDefined();
    expect(f.pod().status).toBe('validated');
    f.provider.verifyMergedSourceAncestry.mockResolvedValue({
      publishedHeadSha: f.publication.commitSha,
      mergedHeadSha: head,
      target: f.target,
      observedAt: new Date().toISOString(),
    });
    await f.approve(true);
    expect(f.pod().status).toBe('complete');
    expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 0 });
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
  });

  it('retains an admitted merge across lookup failure and reconciles without replaying it', async () => {
    const f = await fixture(true);
    f.podRepo.update('prepare', { status: 'merging' });
    const ledger = f.podRepo.sourcePublications;
    const journal = f.podRepo.mergeJournal;
    const publication = ledger?.latestConfirmedForMerge?.(f.pod());
    if (!journal || !publication) throw new Error('Missing native delivery evidence');
    const entry = journal.plan(
      f.pod(),
      { ...f.pod(), prUrl: publication.publicationPrUrl },
      publication.publicationId,
      {
        prUrl: f.pod().prUrl ?? '',
        expectedHeadSha: publication.commitSha,
        expectedTarget: f.target,
      },
    );
    journal.claim(
      f.pod(),
      { ...f.pod(), prUrl: publication.publicationPrUrl },
      publication.publicationId,
      entry.request.config,
    );
    f.podRepo.update('prepare', { status: 'validated' });
    f.provider.getPrStatus.mockRejectedValueOnce(new Error('Read-only lookup failed'));
    await expect(f.approve()).rejects.toBeDefined();
    expect(journal.find(f.pod())?.state).toBe('admitted');
    expect(f.pod().status).toBe('validated');
    await f.approve();
    expect(f.pod().status).toBe('complete');
    expect(f.db.prepare('SELECT count(*) AS n FROM merge_attempts').get()).toEqual({ n: 1 });
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
  });

  it('rechecks retained source after provider ancestry awaits before cleanup', async () => {
    const f = await fixture(true);
    const head = 'c'.repeat(40);
    f.provider.getPrStatus.mockResolvedValue(
      pendingStatus({ merged: true, open: false, headSha: head, sourceTarget: f.target }),
    );
    f.provider.verifyMergedSourceAncestry.mockImplementation(async () => {
      f.worktreeManager.inspectSource.mockResolvedValue({
        branch: f.publication.branch,
        commitSha: 'd'.repeat(40),
        treeSha: f.publication.treeSha,
        worktreeClean: true,
      });
      return {
        publishedHeadSha: f.publication.commitSha,
        mergedHeadSha: head,
        target: f.target,
        observedAt: new Date().toISOString(),
      };
    });
    await expect(f.approve()).rejects.toMatchObject({ code: 'DELIVERY_RECONCILIATION_REQUIRED' });
    expect(f.pod().status).toBe('validated');
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
  });

  it.each([
    'repository',
    'branch',
    'base',
    'unrelated',
    'dirty',
    'changed',
    'closed',
    'unavailable',
    'automation',
    'missing-publication',
    'replaced-resource',
    'compromised',
    'stale-await',
  ] as const)('retains resources and refuses unsupported evidence (%s)', async (kind) => {
    const f = await fixture(true);
    if (kind === 'repository')
      f.provider.getPrStatus.mockResolvedValue(
        pendingStatus({
          merged: true,
          open: false,
          headSha: f.publication.commitSha,
          sourceTarget: { ...f.target, repository: 'https://github.com/other/repo' },
        }),
      );
    if (kind === 'branch' || kind === 'base')
      f.provider.getPrStatus.mockResolvedValue(
        pendingStatus({
          merged: true,
          open: false,
          headSha: f.publication.commitSha,
          sourceTarget: {
            ...f.target,
            ...(kind === 'branch' ? { branch: 'other' } : { baseBranch: 'other' }),
          },
        }),
      );
    if (kind === 'unrelated')
      f.provider.getPrStatus.mockResolvedValue(
        pendingStatus({
          merged: true,
          open: false,
          headSha: 'd'.repeat(40),
          sourceTarget: f.target,
        }),
      );
    if (kind === 'dirty' || kind === 'changed')
      f.worktreeManager.inspectSource.mockResolvedValue({
        branch: f.publication.branch,
        commitSha: kind === 'changed' ? 'd'.repeat(40) : f.publication.commitSha,
        treeSha: f.publication.treeSha,
        worktreeClean: kind !== 'dirty',
      });
    if (kind === 'closed') f.provider.getPrStatus.mockResolvedValue(pendingStatus({ open: false }));
    if (kind === 'unavailable')
      f.provider.getPrStatus.mockRejectedValue(new Error('Provider unavailable'));
    if (kind === 'missing-publication') f.podRepo.incrementLifecycleGeneration('prepare');
    if (kind === 'replaced-resource')
      f.podRepo.update('prepare', { containerId: 'replacement-resource' });
    if (kind === 'compromised') f.podRepo.update('prepare', { worktreeCompromised: true });
    if (kind === 'stale-await')
      f.provider.getPrStatus.mockImplementation(async () => {
        f.podRepo.incrementLifecycleGeneration('prepare');
        return pendingStatus({
          merged: true,
          open: false,
          headSha: f.publication.commitSha,
          sourceTarget: f.target,
        });
      });
    await expect(
      kind === 'automation' ? f.workflow.approveSession('prepare') : f.approve(),
    ).rejects.toBeDefined();
    expect(f.pod().status).toBe(kind === 'stale-await' ? 'merging' : 'validated');
    expect(f.provider.mergePr).not.toHaveBeenCalled();
    expect(f.worktreeManager.pushBranch).not.toHaveBeenCalled();
    expect(f.mainCaptured.cleanupContainerAfterAdvisorySettles).not.toHaveBeenCalled();
  });
});
