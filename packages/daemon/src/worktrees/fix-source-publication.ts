import type { Pod } from '@autopod/shared';
import type { PrMergeStatus } from '../interfaces/pr-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import type { MergeJournal, MergeJournalEntry } from '../pods/merge-journal.js';
import type { PodRepository } from '../pods/pod-repository.js';
import type { SourcePublicationLedger } from '../pods/source-publication-ledger.js';
import {
  assertMergeRepository,
  assertMergeSource,
  assertMergeTarget,
  mergeReconciliation,
} from './merge-source-identity.js';

/** Never replace an uncertain/scheduled merge with a new source. */
export function assertFixPublicationAllowed(
  journal: MergeJournal,
  parent: Pod,
  entry: MergeJournalEntry,
): void {
  if ((entry.state !== 'planned' && entry.state !== 'pending') || entry.result?.autoMergeScheduled)
    mergeReconciliation('The earlier merge must be reconciled before publishing a fix.');
  // Also checks unresolved requests on the same provider PR from other lifecycles.
  journal.plan(
    parent,
    { ...parent, prUrl: entry.request.publicationPrUrl },
    entry.publicationId,
    entry.request.config,
  );
}

export async function publishFixSource(
  pods: PodRepository,
  parent: Pod,
  fix: Pod,
  repository: string,
  manager: WorktreeManager,
  pat: string | undefined,
): Promise<void> {
  const ledger = pods.sourcePublications;
  const journal = pods.mergeJournal;
  const entry = journal?.find(parent);
  if (!ledger || !journal || !entry || !fix.worktreePath)
    return mergeReconciliation('The parent delivery history is unavailable for fix publication.');
  assertFixPublicationAllowed(journal, parent, entry);
  const previousHandoff = ledger.fixForMerge(parent);
  if (previousHandoff && previousHandoff.publicationId !== entry.publicationId)
    return mergeReconciliation(
      'The previous fix publication must be reconciled before another push.',
    );
  let publicationId: string | undefined;
  const receipt = await manager.pushBranch(fix.worktreePath, fix.branch, {
    force: true,
    pat,
    expectedRepository: repository,
    onPrepared(source) {
      if (journal.find(parent)?.id !== entry.id)
        mergeReconciliation('Parent delivery changed before the fix could be published.');
      assertFixPublicationAllowed(journal, parent, entry);
      assertMergeRepository(entry.request.config.expectedTarget, repository);
      assertMergeTarget(entry.request.config.expectedTarget, {
        repository: source.repository,
        branch: source.branch,
        baseBranch: fix.baseBranch ?? entry.request.config.expectedTarget.baseBranch,
      });
      publicationId = ledger.admitFix(parent, fix, source, entry.id);
    },
  });
  if (!publicationId || !receipt)
    return mergeReconciliation('Fix publication requires a durable source receipt.');
  ledger.confirm(parent, publicationId, receipt);
  // Plan, do not merge. The parent's poller remains the sole delivery owner.
  journal.plan(parent, parent, publicationId, {
    ...entry.request.config,
    expectedHeadSha: receipt.commitSha,
  });
}

/** Recover the push→receipt→plan crash windows using source-bound provider evidence. */
export function reconcileFixPublication(
  journal: MergeJournal,
  ledger: SourcePublicationLedger,
  parent: Pod,
  entry: MergeJournalEntry,
  status: PrMergeStatus,
): MergeJournalEntry {
  const handoff = ledger.fixForMerge(parent);
  if (!handoff || handoff.publicationId === entry.publicationId) return entry;
  if (handoff.priorMergeIntentId !== entry.id)
    return mergeReconciliation('The fix publication belongs to a different parent merge intent.');
  assertFixPublicationAllowed(journal, parent, entry);
  assertMergeSource(handoff.source.commitSha, status.headSha);
  assertMergeTarget(entry.request.config.expectedTarget, status.sourceTarget ?? {});
  if (!handoff.confirmed) {
    ledger.confirm(parent, handoff.publicationId, {
      ...handoff.source,
      observedRemoteCommitSha: handoff.source.commitSha,
      observedAt: new Date().toISOString(),
    });
  }
  return journal.plan(parent, parent, handoff.publicationId, {
    ...entry.request.config,
    expectedHeadSha: handoff.source.commitSha,
  });
}
