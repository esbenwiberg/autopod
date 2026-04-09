import type { ValidationOverride, ValidationResult } from '@autopod/shared';
import { findingId } from './finding-fingerprint.js';

/**
 * Applies human-reviewed overrides to a ValidationResult.
 * Returns a new result with dismissed findings removed and `overall` recomputed.
 *
 * Only processes 'dismiss' overrides — 'guidance' overrides are passed to the agent
 * as correction context, not applied to the result.
 */
export function applyOverrides(
  result: ValidationResult,
  overrides: ValidationOverride[],
): ValidationResult {
  const dismissedIds = new Set(
    overrides.filter((o) => o.action === 'dismiss').map((o) => o.findingId),
  );

  if (dismissedIds.size === 0) return result;

  // Deep clone to avoid mutating the original
  const patched: ValidationResult = JSON.parse(JSON.stringify(result));

  // Apply to AC validation results
  if (patched.acValidation && patched.acValidation.results.length > 0) {
    for (const check of patched.acValidation.results) {
      if (!check.passed && isDismissed(dismissedIds, 'ac_validation', check.criterion)) {
        check.passed = true;
        check.reasoning = `[DISMISSED BY HUMAN] ${check.reasoning}`;
      }
    }
    // Recompute AC status
    const anyFailed = patched.acValidation.results.some((r) => !r.passed);
    patched.acValidation.status = anyFailed ? 'fail' : 'pass';
  }

  // Apply to task review issues
  if (patched.taskReview && patched.taskReview.status === 'fail') {
    patched.taskReview.issues = patched.taskReview.issues.filter(
      (issue) => !isDismissed(dismissedIds, 'task_review', issue),
    );

    // Apply to requirements check
    if (patched.taskReview.requirementsCheck) {
      for (const item of patched.taskReview.requirementsCheck) {
        if (!item.met && isDismissed(dismissedIds, 'requirements_check', item.criterion)) {
          item.met = true;
          item.note = `[DISMISSED BY HUMAN] ${item.note ?? ''}`.trim();
        }
      }
    }

    // Recompute task review status
    const hasUnmetRequirements = patched.taskReview.requirementsCheck?.some((r) => !r.met);
    const hasIssues = patched.taskReview.issues.length > 0;
    if (!hasUnmetRequirements && !hasIssues) {
      patched.taskReview.status = 'pass';
      patched.taskReview.reasoning = `[OVERRIDES APPLIED] ${patched.taskReview.reasoning}`;
    }
  }

  // Recompute overall
  patched.overall = computeOverall(patched);

  return patched;
}

/**
 * Checks whether a finding with the given source and text has been dismissed.
 * Recomputes the finding ID via the shared fingerprint function.
 */
function isDismissed(
  dismissedIds: Set<string>,
  source: 'ac_validation' | 'task_review' | 'requirements_check',
  text: string,
): boolean {
  return dismissedIds.has(findingId(source, text));
}

function computeOverall(result: ValidationResult): 'pass' | 'fail' {
  // Build/health/smoke failures are objective and not overridable
  if (result.smoke.build.status === 'fail') return 'fail';
  if (result.smoke.health.status === 'fail') return 'fail';
  if (result.smoke.pages.some((p) => p.status === 'fail')) return 'fail';
  if (result.test?.status === 'fail') return 'fail';

  // AI-driven checks after overrides
  if (result.acValidation?.status === 'fail') return 'fail';
  if (result.taskReview?.status === 'fail') return 'fail';

  return 'pass';
}
