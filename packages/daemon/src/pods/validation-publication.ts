import type { ValidationResult } from '@autopod/shared';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';
import type { StoredValidation, ValidationRepository } from './validation-repository.js';

interface ValidationPublicationDependencies {
  podRepo: Pick<PodRepository, 'update' | 'getOrThrow'>;
  validationRepo?: Pick<ValidationRepository, 'insert'>;
  eventBus: Pick<EventBus, 'emit'>;
}

/** Publish one completed attempt synchronously; callers retain lifecycle and delivery authority. */
export function createValidationPublication(deps: ValidationPublicationDependencies): {
  publishValidationResult(
    podId: string,
    attempt: number,
    result: ValidationResult,
  ): StoredValidation | undefined;
} {
  const { podRepo, validationRepo, eventBus } = deps;

  function publishValidationResult(
    podId: string,
    attempt: number,
    result: ValidationResult,
  ): StoredValidation | undefined {
    podRepo.update(podId, { lastValidationResult: result });

    // Accumulate phase-level token usage for harness cost attribution
    const reviewTokenUsage = result.taskReview?.tokenUsage ?? result.reviewTokenUsage;
    if (reviewTokenUsage) {
      const currentPod = podRepo.getOrThrow(podId);
      const existing = currentPod.phaseTokenUsage ?? {};
      const prev = existing.review ?? { inputTokens: 0, outputTokens: 0 };
      const cachedInputTokens =
        (prev.cachedInputTokens ?? 0) + (reviewTokenUsage.cachedInputTokens ?? 0);
      const costUsd = (prev.costUsd ?? 0) + (reviewTokenUsage.costUsd ?? 0);
      podRepo.update(podId, {
        phaseTokenUsage: {
          ...existing,
          review: {
            inputTokens: prev.inputTokens + reviewTokenUsage.inputTokens,
            outputTokens: prev.outputTokens + reviewTokenUsage.outputTokens,
            ...(cachedInputTokens > 0 && { cachedInputTokens }),
            ...(costUsd > 0 && { costUsd }),
          },
        },
      });
    }

    // Persist every attempt to validation history
    const validationRecord = validationRepo?.insert(podId, attempt, result);

    eventBus.emit({
      type: 'pod.validation_completed',
      timestamp: new Date().toISOString(),
      podId,
      result,
    });

    return validationRecord;
  }

  return { publishValidationResult };
}
