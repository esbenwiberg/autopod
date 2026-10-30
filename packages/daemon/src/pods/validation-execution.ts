import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ExecutionTarget, Pod, TaskRetryIdentity, ValidationResult } from '@autopod/shared';
import type { Logger } from 'pino';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { REVIEW_RETRY_BLOCKED } from '../interfaces/reviewer-executor.js';
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
import { requiresValidationSettlement } from './validation-recovery-policy.js';

interface ValidationExecutionDependencies {
  logger: Logger;
  containerManagerFactory: {
    get(target: ExecutionTarget): ContainerManager;
  };
  podRepo: Pick<
    PodRepository,
    'getOrThrow' | 'update' | 'taskRetries' | 'validationExecutions' | 'atomically'
  >;
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
  publishValidationResult(
    podId: string,
    attempt: number,
    result: ValidationResult,
    options?: { intermediate?: boolean },
  ): unknown;
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
    const originalTestTimeout = validationConfig.testTimeout;
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
        podRepo.validationExecutions?.assertTaskSettled(podId);
        if (validationConfig.containerId !== pod.containerId)
          throw new TaskRetryBlockedError('Validation resource differs from current lifecycle');
        const recoveryBudget = podRepo.validationExecutions?.budget(pod);
        if (
          recoveryBudget &&
          (!cm.executionResourceScope ||
            !retryLedger ||
            pod.executionTarget !== 'sandbox' ||
            !/^[0-9a-f-]{36}$/i.test(pod.containerId ?? ''))
        )
          throw new TaskRetryBlockedError(
            'Recovery budget cannot be consumed without an exact sandbox dispatch',
          );
        validationConfig.testTimeout = recoveryBudget
          ? recoveryBudget.seconds * 1000
          : originalTestTimeout;
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
        let dispatchId: string | null | undefined = null;
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
            atomicPodChange(podRepo, () => {
              if (
                recoveryBudget &&
                podRepo.validationExecutions?.budget(ownership.assertCurrent())?.id !==
                  recoveryBudget.id
              )
                throw new TaskRetryBlockedError(
                  'Selected recovery test budget expired or changed before dispatch; inspect recovery evidence before retrying',
                );
              retryLedger.start(admission.id);
              dispatchId = podRepo.validationExecutions?.dispatch(
                ownership.assertCurrent(),
                admission.id,
                attempt,
                cm.executionResourceScope,
              );
              if (recoveryBudget) {
                if (!dispatchId)
                  throw new TaskRetryBlockedError(
                    'Recovery budget requires an exact sandbox dispatch',
                  );
                podRepo.validationExecutions?.consumeBudget(recoveryBudget.id, dispatchId);
              }
            });
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
          // A thrown engine has not supplied termination evidence. Keep the
          // synthetic failure distinct from a completed engine outcome.
          result.infrastructureFailure = {
            phase: 'build',
            code: 'VALIDATION_ENGINE_TERMINATION_UNVERIFIED',
            message: 'Validation engine threw without verified execution termination.',
            retryable: false,
          };
        }
        if (dispatchId) result.executionDispatchId = dispatchId;
        atomicPodChange(podRepo, () => {
          if (dispatchId) podRepo.validationExecutions?.recordOutcome(result, dispatchId);
          if (admission && retryLedger)
            retryLedger.finish(
              admission.id,
              requiresValidationSettlement({ lastValidationResult: result })
                ? 'nonretryable'
                : validationController.signal.aborted
                  ? 'cancelled'
                  : result.overall === 'pass'
                    ? 'pass'
                    : result.infrastructureFailure?.retryable ||
                        isReviewInfrastructureOnlyFailure(result)
                      ? 'transient'
                      : 'nonretryable',
              Math.round(performance.now() - started),
            );
        });
        // Publish measured, completed dispatch evidence before any downstream
        // checkpoint/source operation. Logical history/completion stays with the caller.
        if (dispatchId && !requiresValidationSettlement({ lastValidationResult: result }))
          deps.publishValidationResult(podId, attempt, result, { intermediate: true });
        // Settle the exact historical admission before discarding a superseded result.
        ownership.assertCurrent();
        return result;
      } catch (err) {
        ownership.assertCurrent();
        throw err;
      }
    };

    try {
      let result = await runValidation();
      for (const [index, waitMs] of infrastructureBackoffs.entries()) {
        if (
          requiresValidationSettlement({ lastValidationResult: result }) ||
          !result.infrastructureFailure?.retryable ||
          validationController.signal.aborted
        )
          break;
        ownership.assertCurrent();
        // Archive/account the completed intermediate result before the next
        // admission. A raw returned outcome alone is not publication evidence.
        if (result.executionDispatchId)
          deps.publishValidationResult(podId, attempt, result, { intermediate: true });
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
          result.reviewSkipReason?.includes(REVIEW_RETRY_BLOCKED)
            ? `${reviewInfrastructureFailureLabel(result)} — Review not retried until reviewer usage is reconciled (ap reviewer-runs ${podId}) — needs human review`
            : `${reviewInfrastructureFailureLabel(result)} after one Review retry — needs human review`,
        );
      }

      return result;
    } finally {
      validationConfig.testTimeout = originalTestTimeout;
    }
  }

  return { validateWithInfrastructureRetries };
}
