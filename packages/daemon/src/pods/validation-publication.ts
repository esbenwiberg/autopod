import type { ValidationResult } from '@autopod/shared';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { EventBus } from './event-bus.js';
import type { PodRepository } from './pod-repository.js';
import type { StoredValidation, ValidationRepository } from './validation-repository.js';

interface ValidationPublicationDependencies {
  podRepo: Pick<
    PodRepository,
    'update' | 'getOrThrow' | 'validationExecutions' | 'atomically' | 'afterCommit'
  >;
  validationRepo?: Pick<ValidationRepository, 'insert'>;
  eventBus: Pick<EventBus, 'emit' | 'emitAfterCommit'>;
}

/** Publish one completed attempt synchronously; callers retain lifecycle and delivery authority. */
export function createValidationPublication(deps: ValidationPublicationDependencies): {
  publishValidationResult(
    podId: string,
    attempt: number,
    result: ValidationResult,
    options?: { intermediate?: boolean },
  ): StoredValidation | undefined;
} {
  const { podRepo, validationRepo, eventBus } = deps;

  function publishValidationResult(
    podId: string,
    attempt: number,
    result: ValidationResult,
    options?: { intermediate?: boolean },
  ): StoredValidation | undefined {
    const publish = () => {
      const durable = !!result.executionDispatchId && !!podRepo.validationExecutions;
      if (options?.intermediate && !durable) return undefined;
      const freshEvidence = podRepo.validationExecutions?.recordResult(result) !== false;
      if (
        !options?.intermediate &&
        durable &&
        podRepo.validationExecutions?.claimLogicalPublication(result) === false
      )
        return undefined;
      if (!options?.intermediate) podRepo.update(podId, { lastValidationResult: result });

      // Accumulate phase-level token usage for harness cost attribution
      const reviewTokenUsage = result.taskReview?.tokenUsage ?? result.reviewTokenUsage;
      if (reviewTokenUsage && freshEvidence) {
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

      if (options?.intermediate) return undefined;
      // Persist the caller's completed logical validation to history
      const validationRecord = validationRepo?.insert(podId, attempt, result);

      const event = {
        type: 'pod.validation_completed' as const,
        timestamp: new Date().toISOString(),
        podId,
        result,
      };
      if (durable) {
        const afterCommit = podRepo.afterCommit;
        if (!afterCommit)
          throw new Error('Durable validation publication requires after-commit authority');
        // Persist the replayable event in the SAME SQLite transaction as the
        // immutable receipt/history. Only its broadcast waits for commit.
        eventBus.emitAfterCommit(event, (effect) => afterCommit(effect));
      } else eventBus.emit(event);
      return validationRecord;
    };
    return result.executionDispatchId && podRepo.validationExecutions
      ? atomicPodChange(podRepo, publish)
      : publish();
  }

  return { publishValidationResult };
}
