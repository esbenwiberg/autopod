import type { ValidationResult } from '@autopod/shared';

export function isHistoryObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Check only the fields consumed by the export; missing evidence never becomes a pass. */
export function isHistoryValidation(value: unknown): value is ValidationResult {
  if (!isHistoryObject(value) || typeof value.overall !== 'string' || !isHistoryObject(value.smoke))
    return false;
  const { build, health, pages } = value.smoke;
  if (
    !isHistoryObject(build) ||
    typeof build.status !== 'string' ||
    typeof build.output !== 'string' ||
    !isHistoryObject(health) ||
    typeof health.status !== 'string' ||
    !Array.isArray(pages)
  )
    return false;
  if (
    pages.some(
      (page) =>
        !isHistoryObject(page) || typeof page.path !== 'string' || typeof page.status !== 'string',
    )
  )
    return false;
  if (value.taskReview != null) {
    if (
      !isHistoryObject(value.taskReview) ||
      !Array.isArray(value.taskReview.issues) ||
      value.taskReview.issues.some((issue) => typeof issue !== 'string')
    )
      return false;
    if (value.taskReview.reasoning != null && typeof value.taskReview.reasoning !== 'string')
      return false;
  }
  return true;
}
