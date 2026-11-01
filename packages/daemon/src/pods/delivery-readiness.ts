import type { Pod, ReadinessFinding, ReadinessReview } from '@autopod/shared';
import type { MergeJournal } from './merge-journal.js';

/** Read-only delivery evidence. An open PR never releases an admitted unknown merge. */
export function deliveryReadinessBlock(pod: Pod, journal?: MergeJournal): string | null {
  // Completion has consumed delivery proof and may have released the retained
  // resource identity used by journal.find(). Do not re-verify it after cleanup.
  if (pod.status === 'complete') return null;
  if (pod.prUrl && journal) {
    try {
      const entry = journal.find(pod);
      if (entry?.state === 'admitted')
        return 'An earlier merge request has no confirmed outcome. Retain source resources and reconcile the existing PR before retrying approval; an open PR is not proof that the request failed.';
    } catch {
      return 'The recorded merge source or target cannot be verified. Retain source resources and reconcile delivery before retrying approval.';
    }
  }
  if (pod.mergeBlockReason) return pod.mergeBlockReason;
  if (
    pod.failureReason?.startsWith('Approval delivery failed.') ||
    pod.failureReason?.startsWith('Branch preservation failed.') ||
    pod.failureReason?.startsWith('Workspace preservation failed.')
  )
    return pod.failureReason;
  return null;
}

/** Project current blockers without rewriting cached proof or historical approval. */
export function withDeliveryReadiness(
  review: ReadinessReview,
  block: string | null,
): ReadinessReview {
  if (!block) return review;
  const existingRisk = review.areas.some((area) => area.area === 'pr' && area.status === 'risky');
  const finding: ReadinessFinding = {
    id: 'pr-blocked',
    area: 'pr',
    severity: existingRisk ? 'error' : 'warning',
    title: 'Delivery is blocked',
    detail: block,
    sourceRefs: [{ kind: 'pr', label: 'Current delivery and merge evidence' }],
  };
  const prArea = {
    area: 'pr' as const,
    title: 'PR',
    status: existingRisk ? ('risky' as const) : ('needs_review' as const),
    summary: block,
    sourceRefs: finding.sourceRefs,
  };
  return {
    ...review,
    // Delivery recovery is not a validation waiver. Keep genuine risk/waivers,
    // but let an ordinary retry reach the source-bound reconciliation guard.
    status: review.status === 'ready' ? 'needs_review' : review.status,
    summary: block,
    areas: review.areas.some((area) => area.area === 'pr')
      ? review.areas.map((area) => (area.area === 'pr' ? prArea : area))
      : [...review.areas, prArea],
    findings: [...review.findings.filter((item) => item.id !== finding.id), finding],
  };
}
