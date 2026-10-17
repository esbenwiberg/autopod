import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExecutionTarget, Pod, TaskRetryIdentity, ValidationResult } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import type {
  ValidationEngine,
  ValidationEngineConfig,
  ValidationPhaseCallbacks,
} from '../interfaces/validation-engine.js';
import { captureValidationRetryIdentity } from '../validation/retry-identity.js';
import { createValidationIdentityCollector } from '../validation/validation-identity-collector.js';
import type { PodRepository } from './pod-repository.js';
import { waitForRetryBackoff } from './retry-backoff-wait.js';
import { TaskRetryBlockedError } from './task-retry-ledger.js';
import type { captureValidationOwnership } from './validation-ownership.js';

interface ValidationExecutionDependencies {
  logger: Logger;
  containerManagerFactory: {
    get(target: ExecutionTarget): ContainerManager;
  };
  podRepo: Pick<PodRepository, 'getOrThrow' | 'update' | 'taskRetries'>;
  validationEngine: Pick<ValidationEngine, 'validate'>;
  retrySource: {
    validationInfrastructureRetryBackoffMs?: readonly number[];
    captureRetryIdentity?(config: ValidationEngineConfig): Promise<TaskRetryIdentity>;
  };
  recordValidationProvenance(
    config: ValidationEngineConfig,
    purpose: 'validation',
    assertCurrent: () => Pod,
  ): Promise<void>;
  resolveEffectiveBoundProfile(pod: Pod): PodExecutionSettings;
  withReviewerLaunchPreflight(
    config: ValidationEngineConfig,
    ownership: ReturnType<typeof captureValidationOwnership>,
  ): ValidationEngineConfig;
  ownedValidationCallbacks(
    ownership: ReturnType<typeof captureValidationOwnership>,
    callbacks: ValidationPhaseCallbacks | undefined,
  ): ValidationPhaseCallbacks;
  emitActivityStatus(podId: string, message: string): void;
  makeUnexpectedValidationFailureResult(
    podId: string,
    attempt: number,
    error: unknown,
  ): ValidationResult;
  validationInfrastructureFailureLabel(result: ValidationResult): string;
  isReviewInfrastructureOnlyFailure(result: ValidationResult): boolean;
  reviewInfrastructureFailureLabel(result: ValidationResult): string;
}

/** Execute validation with the existing durable admissions and infrastructure retries. */
export function createValidationExecution(deps: ValidationExecutionDependencies): {
  validateWithInfrastructureRetries(
    validationConfig: Parameters<ValidationEngine['validate']>[0],
    validationController: AbortController,
    callbacks: Parameters<ValidationEngine['validate']>[3],
    logMessage: string,
    ownership: ReturnType<typeof captureValidationOwnership>,
  ): Promise<ValidationResult>;
} {
  const {
    logger,
    containerManagerFactory,
    podRepo,
    validationEngine,
    retrySource,
    recordValidationProvenance,
    resolveEffectiveBoundProfile,
    withReviewerLaunchPreflight,
    ownedValidationCallbacks,
    emitActivityStatus,
    makeUnexpectedValidationFailureResult,
    validationInfrastructureFailureLabel,
    isReviewInfrastructureOnlyFailure,
    reviewInfrastructureFailureLabel,
  } = deps;

  async function validateWithInfrastructureRetries(
    validationConfig: Parameters<ValidationEngine['validate']>[0],
    validationController: AbortController,
    callbacks: Parameters<ValidationEngine['validate']>[3],
    logMessage: string,
    ownership: ReturnType<typeof captureValidationOwnership>,
  ): Promise<ValidationResult> {
    const { podId, attempt } = validationConfig;
    ownership.assertCurrent();
    const cm = containerManagerFactory.get(
      validationConfig.executionTarget ?? podRepo.getOrThrow(podId).executionTarget,
    );
    validationConfig.captureEvidenceIdentity ??= createValidationIdentityCollector(
      cm,
      validationConfig,
    );

    const infrastructureBackoffs = retrySource.validationInfrastructureRetryBackoffMs ?? [
      1_000, 5_000,
    ];
    const retryLedger = podRepo.taskRetries;
    const runValidation = async (): Promise<ValidationResult> => {
      try {
        const pod = ownership.assertCurrent();
        await recordValidationProvenance(validationConfig, 'validation', ownership.assertCurrent);
        const identity = retryLedger
          ? await (retrySource.captureRetryIdentity?.(validationConfig) ??
              captureValidationRetryIdentity(cm, validationConfig))
          : null;
        resolveEffectiveBoundProfile(ownership.assertCurrent());
        const bindingHash = createHash('sha256')
          .update(
            JSON.stringify({
              runtime: pod.runtime,
              model: pod.model,
              provider: pod.providerIdSnapshot,
              account: pod.providerAccountIdSnapshot,
              reviewerModel: validationConfig.reviewerModel ?? null,
              reviewerProvider: validationConfig.reviewerProvider ?? null,
            }),
          )
          .digest('hex');
        const admission =
          retryLedger && identity
            ? retryLedger.admit(podId, pod.lifecycleGeneration, identity, bindingHash, [
                ...infrastructureBackoffs,
              ])
            : null;
        if (admission && retryLedger) {
          try {
            await waitForRetryBackoff(admission.notBefore, sleep, () => {
              ownership.assertCurrent();
              if (validationController.signal.aborted)
                throw new TaskRetryBlockedError('Validation admission cancelled during cooldown');
            });
            resolveEffectiveBoundProfile(ownership.assertCurrent());
            if (validationController.signal.aborted)
              throw new TaskRetryBlockedError('Validation admission cancelled before execution');
            retryLedger.start(admission.id);
          } catch (err) {
            retryLedger.finish(admission.id, 'cancelled', null);
            throw err;
          }
        }
        const started = performance.now();
        let result: ValidationResult;
        try {
          result = await validationEngine.validate(
            withReviewerLaunchPreflight(validationConfig, ownership),
            (phase) => {
              if (ownership.isCurrent()) emitActivityStatus(podId, phase);
            },
            validationController.signal,
            ownedValidationCallbacks(ownership, callbacks),
          );
        } catch (validateErr) {
          logger.error({ err: validateErr, podId, attempt }, logMessage);
          result = makeUnexpectedValidationFailureResult(podId, attempt, validateErr);
        }
        if (admission && retryLedger)
          retryLedger.finish(
            admission.id,
            validationController.signal.aborted
              ? 'cancelled'
              : result.overall === 'pass'
                ? 'pass'
                : result.infrastructureFailure?.retryable ||
                    isReviewInfrastructureOnlyFailure(result)
                  ? 'transient'
                  : 'nonretryable',
            Math.round(performance.now() - started),
          );
        // Settle the exact historical admission before discarding a superseded result.
        ownership.assertCurrent();
        return result;
      } catch (err) {
        ownership.assertCurrent();
        throw err;
      }
    };

    let result = await runValidation();
    for (const [index, waitMs] of infrastructureBackoffs.entries()) {
      if (!result.infrastructureFailure?.retryable || validationController.signal.aborted) break;
      emitActivityStatus(
        podId,
        `${validationInfrastructureFailureLabel(result)} — retrying validation without agent rework (${index + 1}/${infrastructureBackoffs.length})`,
      );
      if (!retryLedger && waitMs > 0) await sleep(waitMs);
      if (validationController.signal.aborted) break;
      try {
        result = await runValidation();
      } catch (err) {
        if (!(err instanceof TaskRetryBlockedError)) throw err;
        // Preserve the result of work that actually executed before the next
        // admission was denied. The caller still records and parks that failure.
        emitActivityStatus(podId, err.message);
        podRepo.update(podId, { failureReason: err.message });
        break;
      }
    }

    if (isReviewInfrastructureOnlyFailure(result)) {
      emitActivityStatus(
        podId,
        `${reviewInfrastructureFailureLabel(result)} after one Review retry — needs human review`,
      );
    }

    return result;
  }

  return { validateWithInfrastructureRetries };
}
