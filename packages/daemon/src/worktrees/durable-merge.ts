import type { Pod } from '@autopod/shared';
import type {
  MergePrConfig,
  MergePrResult,
  PrManager,
  PrMergeStatus,
} from '../interfaces/pr-manager.js';
import type { WorktreeManager } from '../interfaces/worktree-manager.js';
import type { MergeJournal, MergeJournalEntry } from '../pods/merge-journal.js';
import type { SourcePublicationLedger } from '../pods/source-publication-ledger.js';
import type { ConfirmedSourcePublication } from './durable-source-publication.js';
import { mergeReconciliation } from './merge-source-identity.js';

export function closedPrRecoveryReason(
  entry: MergeJournalEntry,
  status: Pod['status'] = 'merge_pending',
): string {
  const recovery =
    entry.state === 'merged'
      ? 'A source-bound merge is already recorded; reconcile the conflicting provider status before cleanup.'
      : entry.state === 'admitted' || entry.result?.autoMergeScheduled
        ? 'The recorded merge request remains unresolved; reconcile that request before retrying delivery.'
        : status === 'validated'
          ? 'Reopen the existing PR, then retry approval of the retained validated source.'
          : 'Reopen the existing PR, then use Resume to revalidate retained source before approving delivery.';
  return `PR closed without merging. Original resources retained. ${recovery}`;
}

/** An open/absent PR response never proves that an ambiguous mutation failed. */
export async function reconcileMerge(
  journal: MergeJournal,
  pod: Pod,
  entry: MergeJournalEntry,
  provider: PrManager,
  observedStatus?: PrMergeStatus,
): Promise<MergePrResult> {
  journal.check(pod, entry);
  if (entry.state === 'merged' && entry.result?.merged) return entry.result;
  const status =
    observedStatus ??
    (await provider.getPrStatus({
      prUrl: entry.request.config.prUrl,
      worktreePath: pod.worktreePath ?? undefined,
    }));
  if (status.merged === false && status.open === false) {
    journal.observeStatus(entry.id, status);
    journal.check(pod, entry);
    return mergeReconciliation(closedPrRecoveryReason(entry, pod.status));
  }
  if (status.merged !== true || !status.headSha || !status.sourceTarget)
    return mergeReconciliation(
      'The earlier merge is not confirmed for its admitted source and target.',
    );
  const result: MergePrResult = {
    merged: true,
    autoMergeScheduled: false,
    source: {
      headSha: status.headSha,
      target: status.sourceTarget,
      observedAt: new Date().toISOString(),
    },
  };
  if (entry.attemptId) journal.observe(entry.attemptId, result, 'provider_lookup');
  else journal.observeDisposition(entry.id, result);
  journal.check(pod, entry);
  return result;
}

export async function mergePublishedSource(
  journal: MergeJournal,
  pod: Pod,
  publicationPod: Pod,
  publication: ConfirmedSourcePublication,
  provider: PrManager,
  config: MergePrConfig,
): Promise<MergePrResult> {
  const previous = journal.find(pod);
  if (
    previous &&
    ((previous.state !== 'pending' && previous.state !== 'planned') ||
      previous.result?.autoMergeScheduled)
  ) {
    if (
      previous.publicationId !== publication.publicationId ||
      previous.request.config.squash !== (config.squash === true)
    )
      return mergeReconciliation(
        'The earlier merge source or method requires reconciliation before another request.',
      );
    return reconcileMerge(journal, pod, previous, provider);
  }
  let attemptId: string | undefined;
  // Preserve the original requested identity separately from the provider's object.
  const expected = {
    ...config,
    expectedTarget: config.expectedTarget ? { ...config.expectedTarget } : undefined,
  };
  try {
    const result = await provider.mergePr({
      ...config,
      expectedTarget: config.expectedTarget ? { ...config.expectedTarget } : undefined,
      onPrepared() {
        config.onPrepared?.();
        if (attemptId)
          return mergeReconciliation('The provider attempted merge admission more than once.');
        attemptId = journal.claim(pod, publicationPod, publication.publicationId, expected);
      },
    });
    if (!attemptId)
      return mergeReconciliation('The provider did not establish durable merge admission.');
    journal.observe(attemptId, result, 'merge_response');
    const admitted = journal.find(pod);
    if (!admitted)
      return mergeReconciliation('The merge lifecycle changed before confirmation was consumed.');
    journal.check(pod, admitted);
    return result;
  } catch (error) {
    if (attemptId) {
      const admitted = journal.find(pod);
      if (admitted) return reconcileMerge(journal, pod, admitted, provider);
    }
    throw error;
  }
}

/** Read-only proof for consuming a historical merge or retrying its exact source. */
export async function inspectRetainedMergeSource(
  journal: MergeJournal,
  publications: SourcePublicationLedger | undefined,
  pod: Pod,
  entry: MergeJournalEntry,
  manager: WorktreeManager,
): Promise<ConfirmedSourcePublication> {
  journal.check(pod, entry);
  const source = publications?.confirmedForMerge(
    { ...pod, prUrl: entry.request.publicationPrUrl },
    pod,
    entry.publicationId,
  );
  if (!source || !pod.worktreePath || !manager.inspectSource)
    return mergeReconciliation('Retained local source cannot be verified before delivery.');
  const snapshot = await manager.inspectSource(pod.worktreePath, pod.branch);
  journal.check(pod, entry);
  if (
    !snapshot.worktreeClean ||
    snapshot.branch !== source.branch ||
    snapshot.commitSha !== source.commitSha ||
    snapshot.treeSha !== source.treeSha
  )
    return mergeReconciliation('Retained local source changed after the admitted publication.');
  return { ...source, publicationId: entry.publicationId };
}
