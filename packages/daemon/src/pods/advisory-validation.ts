import type { Pod, ValidationResult } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ValidationEngine } from '../interfaces/validation-engine.js';
import type { NudgeRepository } from './nudge-repository.js';
import type { PodRepository } from './pod-repository.js';
import { captureValidationOwnership } from './validation-ownership.js';
import type { createValidationProgress } from './validation-progress.js';
import { assertValidationMutationSettled } from './validation-recovery-policy.js';
import type { ValidationRepository } from './validation-repository.js';

interface AdvisoryValidationDependencies {
  podRepo: Pick<
    PodRepository,
    'getOrThrow' | 'update' | 'hasUnansweredDecision' | 'validationExecutions'
  >;
  nudgeRepo: Pick<NudgeRepository, 'hasPending'>;
  validationRepo?: Pick<ValidationRepository, 'isLatestForPod' | 'updateAdvisoryResult'>;
  validationEngine: Pick<ValidationEngine, 'runAdvisoryBrowserQa'>;
  logger: Pick<Logger, 'warn'>;
  advisoryRuns: Pick<Map<string, Promise<ValidationResult>>, 'get' | 'set' | 'delete'>;
  acquireAdvisoryQaSlot(): Promise<void>;
  releaseAdvisoryQaSlot(): void;
  buildPhaseEventCallbacks: ReturnType<typeof createValidationProgress>['buildPhaseEventCallbacks'];
  ownedValidationCallbacks: ReturnType<typeof createValidationProgress>['ownedValidationCallbacks'];
  refreshReadiness(podId: string, options?: { advisoryQaInFlight?: boolean }): boolean;
  emitActivityStatus(podId: string, message: string): void;
}

export function createAdvisoryValidation(deps: AdvisoryValidationDependencies): {
  advisoryPublicationOwnership(
    expectedPod: Pod,
    blockingResult: ValidationResult,
    validationId: string | undefined,
    ownsInvocation?: () => boolean,
  ): ReturnType<typeof captureValidationOwnership>;
  runAdvisoryAfterValidation(
    podId: string,
    validationConfig: Parameters<ValidationEngine['validate']>[0],
    blockingResult: ValidationResult,
    validationId: string | undefined,
    expectedPod: Pod,
  ): Promise<ValidationResult>;
} {
  const {
    podRepo,
    nudgeRepo,
    validationRepo,
    validationEngine,
    logger,
    advisoryRuns,
    acquireAdvisoryQaSlot,
    releaseAdvisoryQaSlot,
    buildPhaseEventCallbacks,
    ownedValidationCallbacks,
    refreshReadiness,
    emitActivityStatus,
  } = deps;

  function advisoryPublicationOwnership(
    expectedPod: Pod,
    blockingResult: ValidationResult,
    validationId: string | undefined,
    ownsInvocation: () => boolean = () => true,
  ) {
    return captureValidationOwnership(expectedPod, {
      statuses: ['validated'],
      readCurrent: () => podRepo.getOrThrow(expectedPod.id),
      hasPendingDecision: () =>
        nudgeRepo.hasPending(expectedPod.id) ||
        (podRepo.hasUnansweredDecision?.(expectedPod.id) ??
          Boolean(podRepo.getOrThrow(expectedPod.id).pendingEscalation)),
      isCurrentInvocation: () => {
        if (!ownsInvocation()) return false;
        try {
          assertValidationMutationSettled(podRepo, expectedPod.id);
          return (
            podRepo.getOrThrow(expectedPod.id).lastValidationResult?.attempt ===
              blockingResult.attempt &&
            (!validationId ||
              !validationRepo ||
              validationRepo.isLatestForPod(expectedPod.id, validationId))
          );
        } catch {
          return false;
        }
      },
    });
  }

  async function runAdvisoryAfterValidation(
    podId: string,
    validationConfig: Parameters<ValidationEngine['validate']>[0],
    blockingResult: ValidationResult,
    validationId: string | undefined,
    expectedPod: Pod,
  ): Promise<ValidationResult> {
    if (!validationEngine.runAdvisoryBrowserQa) {
      return blockingResult;
    }

    let registered = false;
    const ownership = advisoryPublicationOwnership(
      expectedPod,
      blockingResult,
      validationId,
      () => !registered || advisoryRuns.get(podId) === run,
    );
    ownership.assertCurrent();

    const mergeAdvisoryResult = (
      advisoryResult: ValidationResult['advisoryBrowserQa'],
    ): ValidationResult => {
      if (!advisoryResult) return blockingResult;

      const storedResult = {
        ...blockingResult,
        advisoryBrowserQa: advisoryResult,
      };
      if (validationId) validationRepo?.updateAdvisoryResult(podId, validationId, advisoryResult);
      if (!ownership.isCurrent()) return storedResult;
      const current = podRepo.getOrThrow(podId);

      const currentResult = current.lastValidationResult ?? blockingResult;

      const mergedResult = {
        ...currentResult,
        advisoryBrowserQa: advisoryResult,
      };
      podRepo.update(podId, { lastValidationResult: mergedResult });
      refreshReadiness(podId, { advisoryQaInFlight: false });
      return mergedResult;
    };

    const run = (async (): Promise<ValidationResult> => {
      let advisoryResult: ValidationResult['advisoryBrowserQa'] | null = null;
      try {
        emitActivityStatus(podId, 'Waiting for advisory browser QA slot…');
        await acquireAdvisoryQaSlot();
        try {
          ownership.assertCurrent();
          const callbacks = buildPhaseEventCallbacks(podId);
          const runAdvisoryBrowserQa = validationEngine.runAdvisoryBrowserQa;
          if (!runAdvisoryBrowserQa) {
            throw new Error('Advisory browser QA is no longer available');
          }
          advisoryResult = await runAdvisoryBrowserQa.call(
            validationEngine,
            validationConfig,
            blockingResult,
            (phase) => {
              if (ownership.isCurrent()) emitActivityStatus(podId, phase);
            },
            undefined,
            {
              ...ownedValidationCallbacks(ownership, callbacks),
              onPhaseCompleted: (phase, phaseStatus, phaseResult) => {
                if (phase === 'advisory') {
                  mergeAdvisoryResult(phaseResult as ValidationResult['advisoryBrowserQa']);
                }
                if (ownership.isCurrent())
                  callbacks.onPhaseCompleted?.(phase, phaseStatus, phaseResult);
              },
            },
          );
        } finally {
          releaseAdvisoryQaSlot();
        }
      } catch (err) {
        ownership.assertCurrent();
        logger.warn({ err, podId }, 'Advisory browser QA failed after validation');
        emitActivityStatus(podId, 'Advisory browser QA failed — continuing');
        return blockingResult;
      }

      if (!advisoryResult) {
        ownership.assertCurrent();
        return blockingResult;
      }

      // This is cumulative observed usage for the original immutable pod/task,
      // not authority to publish into the current lifecycle or release it.
      const current = podRepo.getOrThrow(podId);

      if (advisoryResult.tokenUsage) {
        const existingUsage = current.phaseTokenUsage ?? {};
        const prevAdvisory = existingUsage.advisory ?? { inputTokens: 0, outputTokens: 0 };
        const cachedInputTokens =
          (prevAdvisory.cachedInputTokens ?? 0) +
          (advisoryResult.tokenUsage.cachedInputTokens ?? 0);
        const costUsd = (prevAdvisory.costUsd ?? 0) + (advisoryResult.tokenUsage.costUsd ?? 0);
        podRepo.update(podId, {
          phaseTokenUsage: {
            ...existingUsage,
            advisory: {
              inputTokens: prevAdvisory.inputTokens + advisoryResult.tokenUsage.inputTokens,
              outputTokens: prevAdvisory.outputTokens + advisoryResult.tokenUsage.outputTokens,
              ...(cachedInputTokens > 0 && { cachedInputTokens }),
              ...(costUsd > 0 && { costUsd }),
            },
          },
        });
      }

      // Always persist the advisory result into validation history regardless of
      // whether a newer validation attempt has superseded the live lastValidationResult.
      if (validationId) validationRepo?.updateAdvisoryResult(podId, validationId, advisoryResult);
      ownership.assertCurrent();
      const currentResult = current.lastValidationResult ?? blockingResult;

      const mergedResult = {
        ...currentResult,
        advisoryBrowserQa: advisoryResult,
      };
      podRepo.update(podId, { lastValidationResult: mergedResult });
      refreshReadiness(podId, { advisoryQaInFlight: false });
      return mergedResult;
    })();

    advisoryRuns.set(podId, run);
    registered = true;
    try {
      return await run;
    } catch (err) {
      ownership.assertCurrent();
      throw err;
    } finally {
      if (advisoryRuns.get(podId) === run) {
        advisoryRuns.delete(podId);
      }
    }
  }

  return { advisoryPublicationOwnership, runAdvisoryAfterValidation };
}
