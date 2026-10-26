import type Database from 'better-sqlite3';
import { canonicalMergePrIdentity } from '../worktrees/merge-pr-identity.js';
import { createPodRepository } from './pod-repository.js';

export interface MergeRecoveryEvidence {
  observedAt: string;
  prUrl: string;
  pr: {
    pullRequestId: number;
    status: string;
    mergeStatus: string;
    sourceRefName: string;
    targetRefName: string;
    lastMergeSourceCommit: { commitId: string };
    repository: { webUrl: string };
    forkSource?: unknown;
    autoCompleteSetBy?: unknown;
    completionOptions?: unknown;
    completionQueueTime?: unknown;
  };
}
export interface MergeRecoveryInput {
  podId: string;
  attemptId: string;
  headSha: string;
  actor: string;
  reason: string;
  evidence: MergeRecoveryEvidence;
  local: { branch: string; headSha: string; clean: boolean };
}

/** Explicit operator risk acceptance, NOT proof of the original request's outcome.
 * The CLI requires a backup and fresh source-bound ADO evidence. No provider mutation,
 * lifecycle change, or fabricated merge response is performed here.
 */
export function recoverUncertainMerge(
  db: Database.Database,
  input: MergeRecoveryInput,
  apply: boolean,
) {
  const check = () => {
    const fail = (message: string): never => {
      throw new Error(`Merge recovery refused: ${message}`);
    };
    const { evidence, local } = input;
    const age = Date.now() - Date.parse(evidence.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 120_000) fail('provider evidence is not fresh');
    if (!input.actor.trim() || input.reason.trim().length < 20)
      fail('actor and meaningful reason required');
    const pods = createPodRepository(db);
    const pod = pods.getOrThrow(input.podId);
    if (pod.status !== 'validated' || pod.pendingEscalation || pod.worktreeCompromised)
      fail('pod is not retained and validated');
    const entry = pods.mergeJournal?.find(pod);
    if (!entry || entry.state !== 'admitted' || entry.attemptId !== input.attemptId)
      return fail('exact unresolved attempt changed');
    const attempt = db
      .prepare('SELECT admitted_at AS admittedAt FROM merge_attempts WHERE id = ?')
      .get(input.attemptId) as { admittedAt: string };
    // Never authorize recovery while an ordinary in-flight request might still be executing.
    const attemptAge = Date.now() - Date.parse(attempt.admittedAt);
    if (!Number.isFinite(attemptAge) || attemptAge < 30 * 60_000)
      fail('request is less than 30 minutes old');
    const expected = entry.request.config;
    const pr = evidence.pr;
    const identity = canonicalMergePrIdentity(evidence.prUrl);
    if (
      identity !== canonicalMergePrIdentity(expected.prUrl) ||
      identity !==
        canonicalMergePrIdentity(`${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`)
    )
      fail('PR identity mismatch');
    if (!evidence.prUrl.startsWith('https://dev.azure.com/'))
      fail('only ADO evidence is supported');
    if (
      pr.status !== 'active' ||
      pr.mergeStatus !== 'succeeded' ||
      pr.forkSource ||
      pr.autoCompleteSetBy ||
      pr.completionOptions ||
      pr.completionQueueTime
    )
      fail('provider indicates a closed, scheduled, conflicting or completing PR');
    if (
      input.headSha !== expected.expectedHeadSha ||
      pr.lastMergeSourceCommit.commitId !== input.headSha ||
      pr.sourceRefName !== `refs/heads/${expected.expectedTarget.branch}` ||
      pr.targetRefName !== `refs/heads/${expected.expectedTarget.baseBranch}`
    )
      fail('provider source/target differs from admission');
    if (
      !local.clean ||
      local.headSha !== input.headSha ||
      local.branch !== expected.expectedTarget.branch
    )
      fail('retained local source changed');
    if (apply)
      db.prepare(`INSERT INTO merge_operator_recoveries
      (attempt_id, intent_id, actor, reason, evidence, recovered_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        input.attemptId,
        entry.id,
        input.actor,
        input.reason,
        JSON.stringify({
          ...evidence,
          local,
          originalOutcome: 'unknown',
          decision: 'operator-authorized-retry',
        }),
        new Date().toISOString(),
      );
    return {
      podId: pod.id,
      attemptId: entry.attemptId,
      applied: apply,
      originalOutcome: 'unknown',
      next: 'approve',
    };
  };
  return db.transaction(check).immediate();
}
