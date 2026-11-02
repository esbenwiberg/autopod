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
  sourceHeld = false,
  findingsContract = false,
): ReadinessReview {
  if (
    findingsContract &&
    !sourceHeld &&
    currentValidation === null &&
    ['research_ready', 'complete'].includes(status) &&
    review.areas.some((area) => area.area === 'validation' && area.status === 'not_applicable')
  )
    return review;
  if (
    !sourceHeld &&
    review.status !== 'ready' &&
    !review.findings.some((finding) => finding.id === 'lifecycle-readiness-unresolved')
  )
    return review;
  const unresolved = sourceHeld || !DELIVERY_STATES.has(status);
  const missingProof =
    currentValidation === null &&
    (review.status === 'ready' ||
      review.findings.some(
        (finding) =>
          finding.id === 'lifecycle-readiness-unresolved' && finding.severity === 'error',
      ));
  if (!unresolved && !missingProof) return review;
  const detail = sourceHeld
    ? 'Source adoption custody is not released. Source checks do not authorize publication, merge or report cleanup.'
    : unresolved
      ? `Pod is ${status}, not in a release-ready lifecycle. Code delivery, current validation and report preservation must be assessed separately.`
      : 'Current validation proof is unavailable. Historical validation must not replace an explicitly cleared current result.';
  const attention: ReadinessFinding = {
    id: sourceHeld ? 'source-custody-unreleased' : 'lifecycle-readiness-unresolved',
    area: 'validation',
    severity: missingProof || sourceHeld ? 'error' : 'warning',
    title: unresolved ? 'Pod recovery unresolved' : 'Current validation proof unavailable',
    detail,
    sourceRefs: [{ kind: 'event', label: 'Current pod lifecycle and validation' }],
  };
  return {
    ...review,
    status: review.status === 'risky' || missingProof || sourceHeld ? 'risky' : 'needs_review',
    summary: detail,
    areas: review.areas.map((area) =>
      area.area === 'validation'
        ? {
            ...area,
            status:
              area.status === 'risky' || missingProof || sourceHeld ? 'risky' : 'needs_review',
            summary: detail,
          }
        : area,
    ),
    findings: [...review.findings.filter((finding) => finding.id !== attention.id), attention],
  };
}
