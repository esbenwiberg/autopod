import type Database from 'better-sqlite3';
import { assertFixPublicationAllowed } from '../worktrees/fix-source-publication.js';
import { canonicalMergePrIdentity } from '../worktrees/merge-pr-identity.js';
import { assertMergeSource, assertMergeTarget } from '../worktrees/merge-source-identity.js';
import type { MergeRecoveryEvidence } from './merge-operator-recovery.js';
import { createPodRepository } from './pod-repository.js';
import type { PublicationSource } from './source-publication-ledger.js';

export interface MergedFixRecoveryInput {
  podId: string;
  fixPodId: string;
  actor: string;
  reason: string;
  sourcePath: string;
  local: Omit<PublicationSource, 'worktreeClean'> & { worktreeClean: boolean };
  evidence: MergeRecoveryEvidence;
}

/** Operator-only adoption of a legacy fix's actual, already-merged source.
 * No push, merge request, lifecycle override, or invented original merge response.
 * Historical journals remain intact; the poller consumes the new source-bound fact.
 */
export function recoverMergedFix(
  db: Database.Database,
  input: MergedFixRecoveryInput,
  apply: boolean,
) {
  const fail = (message: string): never => {
    throw new Error(`Merged fix recovery refused: ${message}`);
  };
  if (db.inTransaction) fail('recovery requires committed evidence');
  const { evidence, local } = input;
  const age = Date.now() - Date.parse(evidence.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 120_000) fail('provider evidence is not fresh');
  if (!input.actor.trim() || input.reason.trim().length < 20 || !input.sourcePath.trim())
    fail('actor, source checkout and meaningful reason required');
  const pods = createPodRepository(db);
  const parent = pods.getOrThrow(input.podId);
  const fix = pods.getOrThrow(input.fixPodId);
  const journal = pods.mergeJournal;
  const ledger = pods.sourcePublications;
  const entry = journal?.find(parent);
  if (!journal || !ledger || !entry) return fail('parent delivery history unavailable');
  if (
    parent.status !== 'merge_pending' ||
    fix.status !== 'complete' ||
    parent.fixPodId !== fix.id ||
    fix.linkedPodId !== parent.id ||
    fix.branch !== parent.branch ||
    (fix.baseBranch ?? entry.request.config.expectedTarget.baseBranch) !==
      (parent.baseBranch ?? entry.request.config.expectedTarget.baseBranch) ||
    fix.prUrl !== parent.prUrl ||
    parent.pendingEscalation ||
    fix.pendingEscalation ||
    parent.worktreeCompromised ||
    fix.worktreeCompromised
  )
    fail('exact completed fix and retained parent required');
  const pr = evidence.pr;
  const identity = canonicalMergePrIdentity(evidence.prUrl);
  if (
    !evidence.prUrl.startsWith('https://dev.azure.com/') ||
    identity !== canonicalMergePrIdentity(entry.request.config.prUrl) ||
    identity !== canonicalMergePrIdentity(`${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`)
  )
    fail('ADO PR identity mismatch');
  if (pr.status !== 'completed' || pr.mergeStatus !== 'succeeded' || pr.forkSource)
    fail('provider has not confirmed a merged, non-fork PR');
  assertMergeTarget(entry.request.config.expectedTarget, {
    repository: pr.repository.webUrl,
    branch: pr.sourceRefName.replace(/^refs\/heads\//, ''),
    baseBranch: pr.targetRefName.replace(/^refs\/heads\//, ''),
  });
  assertMergeTarget(entry.request.config.expectedTarget, {
    repository: local.repository,
    branch: local.branch,
    baseBranch: entry.request.config.expectedTarget.baseBranch,
  });
  assertMergeSource(pr.lastMergeSourceCommit.commitId, local.commitSha);
  if (
    !local.worktreeClean ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(local.treeSha) ||
    local.remoteRef !== `refs/heads/${local.branch}`
  )
    fail('clean, exact merged source checkout required');
  const handoff = ledger.fixForMerge(parent);
  if (handoff) fail('a durable fix handoff already exists; let the poller reconcile it');
  assertFixPublicationAllowed(journal, parent, entry);
  if (apply) {
    const source: PublicationSource = { ...local, worktreeClean: true };
    const publicationId = ledger.admitFix(parent, fix, source, entry.id, {
      actor: input.actor,
      reason: input.reason,
      sourcePath: input.sourcePath,
      evidence: JSON.stringify(evidence),
    });
    ledger.confirm(parent, publicationId, {
      ...source,
      observedRemoteCommitSha: pr.lastMergeSourceCommit.commitId,
      observedAt: evidence.observedAt,
    });
    // A crash before planning is safe: the next poll can adopt the persisted handoff.
    journal.plan(parent, parent, publicationId, {
      ...entry.request.config,
      expectedHeadSha: local.commitSha,
    });
  }
  return {
    podId: parent.id,
    fixPodId: fix.id,
    headSha: local.commitSha,
    applied: apply,
    next: 'merge-polling',
  };
}
