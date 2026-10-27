import {
  AutopodError,
  type ValidationRecoveryAction,
  type ValidationRecoveryAvailability,
  type ValidationRecoveryState,
} from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager-contracts.js';
import { assertFailedValidationRecoverable } from '../../pods/validation-recovery-policy.js';

type RecoveryManager = Pick<
  PodManager,
  | 'getSession'
  | 'assertCanRework'
  | 'assertCanRetryValidation'
  | 'triggerValidation'
  | 'revalidateSession'
>;
interface Operation {
  action: ValidationRecoveryAction;
  generation: number;
  validationTimestamp: string;
  active: boolean;
  error?: { code: string; message: string };
}

/** In-flight UI state is not a retry ledger. Existing durable admissions remain authoritative. */
export function validationRecoveryRoutes(
  app: FastifyInstance,
  manager: RecoveryManager,
  legacyRepairActive: (podId: string) => boolean = () => false,
) {
  const operations = new Map<string, Operation>();
  const errorInfo = (error: unknown) =>
    error instanceof AutopodError
      ? { code: error.code, message: error.message }
      : {
          code: 'VALIDATION_RECOVERY_FAILED',
          message: 'Recovery failed. Inspect pod activity before retrying.',
        };
  const assertAllowed = (podId: string, action: ValidationRecoveryAction) => {
    const pod = manager.getSession(podId);
    assertFailedValidationRecoverable(pod);
    if (action === 'fix-validation') {
      if (pod.options.agentMode === 'interactive')
        throw new AutopodError(
          'Hand the workspace to a worker before requesting code repair.',
          'WORKER_REQUIRED',
          409,
        );
      manager.assertCanRework(podId);
    } else manager.assertCanRetryValidation(podId);
  };
  const availability = (
    podId: string,
    action: ValidationRecoveryAction,
  ): ValidationRecoveryAvailability => {
    try {
      assertAllowed(podId, action);
      return { allowed: true };
    } catch (error) {
      const info = errorInfo(error);
      return { allowed: false, code: info.code, reason: info.message };
    }
  };
  const isActive = (podId: string) => operations.get(podId)?.active === true;

  app.get('/pods/:podId/validation-recovery', async (request): Promise<ValidationRecoveryState> => {
    const { podId } = request.params as { podId: string };
    const pod = manager.getSession(podId);
    const operation = operations.get(podId);
    const activeAction = operation?.active
      ? operation.action
      : legacyRepairActive(podId)
        ? 'fix-validation'
        : null;
    const pending: ValidationRecoveryAvailability = {
      allowed: false,
      code: 'RECOVERY_IN_PROGRESS',
      reason: 'Recovery is already running. Inspect activity for progress.',
    };
    return {
      generation: pod.lifecycleGeneration,
      validationTimestamp: pod.lastValidationResult?.timestamp ?? null,
      fixValidation: activeAction ? pending : availability(podId, 'fix-validation'),
      retryChecks: activeAction ? pending : availability(podId, 'retry-checks'),
      activeAction,
      ...(operation?.error && operation.validationTimestamp === pod.lastValidationResult?.timestamp
        ? { lastError: operation.error }
        : {}),
    };
  });

  app.post('/pods/:podId/validation-recovery', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = request.params as { podId: string };
    const input = z
      .object({
        action: z.enum(['fix-validation', 'retry-checks']),
        expectedGeneration: z.number().int().min(0),
        expectedValidationTimestamp: z.string().min(1).max(100),
      })
      .strict()
      .parse(request.body);
    const prior = operations.get(podId);
    if (prior?.active) {
      if (
        prior.action !== input.action ||
        prior.generation !== input.expectedGeneration ||
        prior.validationTimestamp !== input.expectedValidationTimestamp
      )
        throw new AutopodError(
          'Another recovery is already running. Refresh before requesting another action.',
          'RECOVERY_IN_PROGRESS',
          409,
        );
      return reply.code(202).send({ ok: true, accepted: true });
    }
    if (legacyRepairActive(podId))
      throw new AutopodError('Repair is already running.', 'RECOVERY_IN_PROGRESS', 409);
    const pod = manager.getSession(podId);
    if (
      pod.lifecycleGeneration !== input.expectedGeneration ||
      pod.lastValidationResult?.timestamp !== input.expectedValidationTimestamp
    )
      throw new AutopodError(
        'Validation changed. Refresh before requesting recovery.',
        'STALE_VALIDATION_RECOVERY',
        409,
      );
    assertAllowed(podId, input.action);
    const operation: Operation = {
      action: input.action,
      generation: input.expectedGeneration,
      validationTimestamp: input.expectedValidationTimestamp,
      active: true,
    };
    operations.set(podId, operation);
    app.log.info(
      {
        podId,
        action: input.action,
        actorId: request.user.oid,
        generation: input.expectedGeneration,
      },
      'Validation recovery requested',
    );
    // Bound retained UI failures without ever evicting live requests/coalescing ownership.
    for (const [id, entry] of operations) {
      if (operations.size <= 128) break;
      if (!entry.active) operations.delete(id);
    }
    void Promise.resolve()
      .then(async () => {
        if (input.action === 'fix-validation')
          await manager.triggerValidation(podId, { force: true });
        // Deliberately NOT resumePod: that method may collect artifacts or publish a PR.
        else await manager.revalidateSession(podId, { force: true, checksOnly: true });
        // Some established workflows park and return instead of throwing an admission
        // error. Surface that outcome too; accepted is not a claim that checks ran.
        const current = manager.getSession(podId);
        if (
          ['failed', 'review_required'].includes(current.status) &&
          current.lastValidationResult?.timestamp === operation.validationTimestamp &&
          current.failureReason
        )
          operation.error = { code: 'RECOVERY_NOT_STARTED', message: current.failureReason };
      })
      .catch((error: unknown) => {
        operation.error = errorInfo(error);
        app.log.warn(
          { error, podId, action: input.action },
          'Validation recovery did not complete',
        );
      })
      .finally(() => {
        operation.active = false;
      });
    return reply.code(202).send({ ok: true, accepted: true });
  });
  return { isActive };
}
