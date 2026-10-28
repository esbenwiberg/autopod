import type {
  PodStatus,
  ReadinessFinding,
  ReadinessReview,
  ValidationResult,
} from '@autopod/shared';

const DELIVERY_STATES = new Set<PodStatus>([
  'validated',
  'approved',
  'merging',
  'merge_pending',
  'complete',
]);

/** A cached pass/approval must not conceal a later failed or invalidated lifecycle. */
export function withLifecycleReadiness(
  review: ReadinessReview,
  status: PodStatus,
  currentValidation: ValidationResult | null,
): ReadinessReview {
  if (
    review.status !== 'ready' &&
    !review.findings.some((finding) => finding.id === 'lifecycle-readiness-unresolved')
  )
    return review;
  const unresolved = !DELIVERY_STATES.has(status);
  const missingProof =
    currentValidation === null &&
    (review.status === 'ready' ||
      review.findings.some(
        (finding) =>
          finding.id === 'lifecycle-readiness-unresolved' && finding.severity === 'error',
      ));
  if (!unresolved && !missingProof) return review;
  const detail = unresolved
    ? `Pod is ${status}, not in a release-ready lifecycle. Code delivery, current validation and report preservation must be assessed separately.`
    : 'Current validation proof is unavailable. Historical validation must not replace an explicitly cleared current result.';
  const attention: ReadinessFinding = {
    id: 'lifecycle-readiness-unresolved',
    area: 'validation',
    severity: missingProof ? 'error' : 'warning',
    title: unresolved ? 'Pod recovery unresolved' : 'Current validation proof unavailable',
    detail,
    sourceRefs: [{ kind: 'event', label: 'Current pod lifecycle and validation' }],
  };
  return {
    ...review,
    status: review.status === 'risky' || missingProof ? 'risky' : 'needs_review',
    summary: detail,
    areas: review.areas.map((area) =>
      area.area === 'validation'
        ? {
            ...area,
            status: area.status === 'risky' || missingProof ? 'risky' : 'needs_review',
            summary: detail,
          }
        : area,
    ),
    findings: [...review.findings.filter((finding) => finding.id !== attention.id), attention],
  };
}
