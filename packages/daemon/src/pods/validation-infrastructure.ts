import type { Pod, ValidationResult } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { PodRepository, PodUpdates } from './pod-repository.js';
import type { TaskRetryBlockedError } from './task-retry-ledger.js';

interface ValidationInfrastructureDependencies {
  logger: Pick<Logger, 'info' | 'warn'>;
  podRepo: Pick<PodRepository, 'update'>;
  containerManagerFactory: { get(target: Pod['executionTarget']): ContainerManager };
  transition(pod: Pod, to: 'review_required', extraUpdates?: Partial<PodUpdates>): Pod;
  stopSandboxPreviewProxy(podId: string): Promise<void>;
  emitActivityStatus(podId: string, message: string): void;
}

export function isValidationInfrastructureOnlyFailure(result: ValidationResult): boolean {
  return result.overall === 'fail' && result.infrastructureFailure !== undefined;
}

export function validationInfrastructureFailureLabel(result: ValidationResult): string {
  const failure = result.infrastructureFailure;
  if (!failure) return 'Validation infrastructure failure';
  return `Validation infrastructure failure during ${failure.phase}`;
}

export function isReviewInfrastructureOnlyFailure(result: ValidationResult): boolean {
  const councilUnavailable = result.taskReview?.reviewBatch?.infrastructureUnavailable === true;
  const closureStatus = result.taskReview?.reviewBatch?.closureVerification?.status;
  const closureUnavailable = closureStatus === 'unavailable' || closureStatus === 'invalid';
  if (!councilUnavailable && !closureUnavailable && result.taskReview !== null) return false;
  if (
    !councilUnavailable &&
    !closureUnavailable &&
    result.reviewSkipKind !== 'review-timeout' &&
    result.reviewSkipKind !== 'review-failed'
  ) {
    return false;
  }
  if (result.smoke.build.status !== 'pass') return false;
  if (result.smoke.health.status === 'fail') return false;
  if (result.smoke.pages.some((page) => page.status === 'fail')) return false;
  if (result.test?.status === 'fail') return false;
  if (result.lint?.status === 'fail') return false;
  if (result.sast?.status === 'fail') return false;
  if (
    result.factValidation &&
    (result.factValidation.status === 'fail' || result.factValidation.status === 'pending_human')
  ) {
    return false;
  }
  return result.overall === 'fail';
}

export function reviewInfrastructureFailureLabel(result: ValidationResult): string {
  if (result.taskReview?.reviewBatch?.infrastructureUnavailable) {
    return 'Frozen review council infrastructure failure';
  }
  const closureStatus = result.taskReview?.reviewBatch?.closureVerification?.status;
  if (closureStatus === 'unavailable' || closureStatus === 'invalid') {
    return 'Review finding closure infrastructure failure';
  }
  return result.reviewSkipKind === 'review-timeout'
    ? 'Review infrastructure timeout'
    : 'Review infrastructure failure';
}

export function createValidationInfrastructure(deps: ValidationInfrastructureDependencies): {
  parkOnRetryAdmission(pod: Pod, error: TaskRetryBlockedError): Promise<void>;
  parkOnValidationInfrastructureFailure(pod: Pod, result: ValidationResult): Promise<void>;
  parkOnReviewInfrastructureFailure(pod: Pod): Promise<void>;
} {
  const {
    logger,
    podRepo,
    containerManagerFactory,
    transition,
    stopSandboxPreviewProxy,
    emitActivityStatus,
  } = deps;

  async function parkOnRetryAdmission(pod: Pod, error: TaskRetryBlockedError): Promise<void> {
    if (pod.status !== 'validating') return;
    emitActivityStatus(pod.id, error.message);
    transition(pod, 'review_required', { failureReason: error.message });
    podRepo.update(pod.id, { validationAttempts: Math.max(0, pod.validationAttempts - 1) });
    if (pod.containerId) {
      try {
        await stopSandboxPreviewProxy(pod.id);
        await containerManagerFactory.get(pod.executionTarget).stop(pod.containerId);
      } catch (err) {
        logger.warn(
          { err, podId: pod.id },
          'Failed to stop container after retry admission was denied',
        );
      }
    }
  }

  async function parkOnValidationInfrastructureFailure(
    pod: Pod,
    result: ValidationResult,
  ): Promise<void> {
    const label = validationInfrastructureFailureLabel(result);
    emitActivityStatus(pod.id, `${label} — parked for explicit Resume`);
    transition(pod, 'review_required');
    podRepo.update(pod.id, {
      validationAttempts: Math.max(0, pod.validationAttempts - 1),
      lastCorrectionMessage: null,
    });

    if (pod.containerId) {
      try {
        emitActivityStatus(pod.id, 'Stopping post-validation container…');
        await stopSandboxPreviewProxy(pod.id);
        const cm = containerManagerFactory.get(pod.executionTarget);
        await cm.stop(pod.containerId);
        logger.info(
          { podId: pod.id, infrastructureFailure: result.infrastructureFailure },
          'Container stopped after validation infrastructure failure',
        );
      } catch (stopErr) {
        logger.warn(
          { err: stopErr, podId: pod.id },
          'Failed to stop container after validation infrastructure failure',
        );
      }
    }
  }

  async function parkOnReviewInfrastructureFailure(pod: Pod): Promise<void> {
    transition(pod, 'review_required');

    if (pod.containerId) {
      try {
        emitActivityStatus(pod.id, 'Stopping post-validation container…');
        await stopSandboxPreviewProxy(pod.id);
        const cm = containerManagerFactory.get(pod.executionTarget);
        await cm.stop(pod.containerId);
        logger.info({ podId: pod.id }, 'Container stopped after review infrastructure failure');
      } catch (stopErr) {
        logger.warn(
          { err: stopErr, podId: pod.id },
          'Failed to stop container after review infrastructure failure',
        );
      }
    }
  }

  return {
    parkOnRetryAdmission,
    parkOnValidationInfrastructureFailure,
    parkOnReviewInfrastructureFailure,
  };
}
