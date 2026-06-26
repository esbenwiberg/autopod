import type {
  AdvisoryBrowserQaResult,
  FactValidationResult,
  PageResult,
  Pod,
  ScreenshotRef,
  ScreenshotSource,
  SystemEvent,
  TaskReviewResult,
  ValidationResult,
} from '@autopod/shared';
import { redactProfileSecrets } from './profile-redaction.js';

export interface ScreenshotRefDto {
  url: string;
  source: ScreenshotSource;
  path: string;
}

export function toScreenshotRefDto(ref: ScreenshotRef, contextPath: string): ScreenshotRefDto {
  return {
    url: `/pods/${ref.podId}/screenshots/${ref.source}/${ref.filename}`,
    source: ref.source,
    path: contextPath,
  };
}

function serializePages(pages: PageResult[]): unknown[] {
  return pages.map((page) => {
    if (!page.screenshot) return page;
    const { screenshot, ...rest } = page;
    return { ...rest, screenshot: toScreenshotRefDto(screenshot, page.path) };
  });
}

function serializeTaskReview(review: TaskReviewResult): unknown {
  return {
    ...review,
    screenshots: review.screenshots.map((ref, i) => toScreenshotRefDto(ref, String(i))),
  };
}

function serializeAdvisoryBrowserQa(advisory: AdvisoryBrowserQaResult | null | undefined): unknown {
  if (!advisory) return advisory;
  return {
    ...advisory,
    observations: advisory.observations.map((observation) => ({
      ...observation,
      screenshots: observation.screenshots.map((ref, i) =>
        toScreenshotRefDto(ref, `${observation.id}:${i}`),
      ),
    })),
    screenshots: advisory.screenshots.map((ref, i) => toScreenshotRefDto(ref, String(i))),
  };
}

function serializeFactValidation(factValidation: FactValidationResult | null | undefined): unknown {
  if (!factValidation) return factValidation;
  return {
    ...factValidation,
    results: factValidation.results.map((fact) => ({
      ...fact,
      attachments: fact.attachments?.map((attachment) => {
        if (!attachment.screenshot) return attachment;
        const { screenshot, ...rest } = attachment;
        return {
          ...rest,
          screenshot: toScreenshotRefDto(screenshot, attachment.label ?? attachment.path),
        };
      }),
    })),
  };
}

/**
 * Transform a stored ValidationResult, replacing all ScreenshotRef fields with
 * ScreenshotRefDto shapes suitable for the API wire format. Returns a new
 * object — does not mutate the input.
 */
export function serializeValidationResult(result: ValidationResult): unknown {
  return {
    ...result,
    smoke: { ...result.smoke, pages: serializePages(result.smoke.pages) },
    factValidation: serializeFactValidation(result.factValidation),
    taskReview: result.taskReview ? serializeTaskReview(result.taskReview) : result.taskReview,
    advisoryBrowserQa: serializeAdvisoryBrowserQa(result.advisoryBrowserQa),
  };
}

/**
 * Wire-shape a Pod for desktop/CLI consumption. Stored spec files can be
 * bulky, so they are withheld from list/detail payloads; validation evidence
 * keeps its screenshots but exposes URL DTOs instead of internal refs.
 */
export function serializePodForWire(pod: Pod): unknown {
  const hasSpecFilesField = Object.prototype.hasOwnProperty.call(pod, 'specFiles');
  const hasSpecContextFilesField = Object.prototype.hasOwnProperty.call(pod, 'specContextFiles');
  const hasProfileSnapshotField = Object.prototype.hasOwnProperty.call(pod, 'profileSnapshot');
  const basePod = {
    ...pod,
    ...(hasProfileSnapshotField
      ? { profileSnapshot: pod.profileSnapshot ? redactProfileSecrets(pod.profileSnapshot) : null }
      : {}),
    readinessReview: pod.readinessReview ?? null,
  };
  if (!pod.lastValidationResult && !hasSpecFilesField && !hasSpecContextFilesField) {
    return basePod;
  }

  const wirePod = {
    ...(hasSpecFilesField || hasSpecContextFilesField
      ? { ...basePod, specFiles: undefined, specContextFiles: undefined }
      : { ...basePod }),
  };
  if (!wirePod.lastValidationResult) return wirePod;
  return {
    ...wirePod,
    lastValidationResult: serializeValidationResult(wirePod.lastValidationResult),
  };
}

/**
 * Convert a SystemEvent to its wire-format equivalent. Validation events carry
 * ValidationResult / TaskReviewResult / PageResult[] which
 * all embed ScreenshotRef internally; everything else passes through unchanged.
 */
export function serializeSystemEventForWire(event: SystemEvent): SystemEvent {
  switch (event.type) {
    case 'pod.validation_completed':
      return {
        ...event,
        result: serializeValidationResult(event.result) as ValidationResult,
      };
    case 'pod.validation_phase_completed': {
      const next = { ...event };
      if (event.pageResults) {
        next.pageResults = serializePages(event.pageResults) as PageResult[];
      }
      if (event.reviewResult) {
        next.reviewResult = serializeTaskReview(event.reviewResult) as TaskReviewResult;
      }
      if (event.advisoryResult) {
        next.advisoryResult = serializeAdvisoryBrowserQa(
          event.advisoryResult,
        ) as AdvisoryBrowserQaResult;
      }
      return next;
    }
    default:
      return event;
  }
}
