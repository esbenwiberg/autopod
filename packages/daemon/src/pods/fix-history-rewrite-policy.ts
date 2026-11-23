import type { Pod } from '@autopod/shared';
import type { RebaseRewriteEvidence } from '../worktrees/rebase-rewrite-proof.js';

/**
 * Authority for the daemon to adopt a container-side history rewrite (an agent
 * `git rebase origin/<base>`) into the host branch of a Docker pod.
 *
 * Only a canonical PR fix pod qualifies: its branch is already published as a
 * pull request, and fix delivery force-pushes with a lease against the
 * recorded PR head, so a proven rebase can be delivered without a blind force.
 */
export interface FixHistoryRewritePolicy {
  kind: 'canonical-pr-fix';
  podId: string;
  parentPodId: string;
  prUrl: string;
  branch: string;
  baseBranch: string;
}

export function historyRewritePolicyForPod(
  pod: Pod,
  parent: Pod | null,
  defaultBranch?: string | null,
): FixHistoryRewritePolicy | null {
  if (pod.executionTarget !== 'local') return null;
  if (pod.outputMode === 'workspace') return null;
  if (!pod.linkedPodId || !parent || parent.id !== pod.linkedPodId) return null;
  if (parent.fixPodId !== pod.id) return null;
  if (!pod.prUrl || !pod.branch) return null;
  return {
    kind: 'canonical-pr-fix',
    podId: pod.id,
    parentPodId: parent.id,
    prUrl: pod.prUrl,
    branch: pod.branch,
    baseBranch: pod.baseBranch ?? defaultBranch ?? 'main',
  };
}

export interface AdoptedHistoryRewrite {
  policy: FixHistoryRewritePolicy;
  evidence: RebaseRewriteEvidence;
}

/** Durable activity text: the audit record must not depend on daemon logs. */
export function describeAdoptedHistoryRewrite({ policy, evidence }: AdoptedHistoryRewrite): string {
  const accounted = evidence.patchEquivalent + evidence.fingerprintMatched;
  return [
    `Adopted proven agent rebase of ${policy.branch} onto origin/${policy.baseBranch}:`,
    `old head ${evidence.predecessor} → new head ${evidence.candidate}.`,
    `Base ${evidence.baseRef} at ${evidence.baseTip};`,
    `fork point ${evidence.predecessorFork} → ${evidence.candidateFork}.`,
    `${accounted} old commit(s) accounted for`,
    `(${evidence.patchEquivalent} patch-equivalent, ${evidence.fingerprintMatched} matched by author, date and subject).`,
    `Authorized by policy ${policy.kind} (fix of ${policy.parentPodId}, ${policy.prUrl});`,
    'delivery publishes with a lease against the recorded PR head.',
  ].join(' ');
}
