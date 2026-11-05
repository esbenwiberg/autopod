import { AutopodError, type OperatorActor, type ReworkEligibility } from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager-contracts.js';
import type { PodRepository } from '../../pods/pod-repository.js';
import { createReworkRequestRepository } from '../../pods/rework-request-repository.js';
import { assertTaskExecutionTerminationVerified } from '../../pods/task-execution-ledger.js';
import { TaskRetryBlockedError } from '../../pods/task-retry-ledger.js';

export function reworkRoutes(
  app: FastifyInstance,
  manager: Pick<
    PodManager,
    'getSession' | 'assertCanRework' | 'triggerValidation' | 'getLaunchConfiguration'
  >,
  repo: PodRepository | undefined,
  db: Database.Database | undefined,
  legacyActive: (podId: string) => boolean,
) {
  const journal = db ? createReworkRequestRepository(db) : undefined;
  const actor = (request: FastifyRequest): OperatorActor => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    return { type: 'human', userId: request.user.oid };
  };
  const inspect = (podId: string): ReworkEligibility => {
    const pod = manager.getSession(podId);
    const base = {
      generation: pod.lifecycleGeneration,
      failureId: repo?.workerRetries?.state(podId).latest?.id ?? null,
    };
    try {
      if (!journal || !repo?.workerRetries)
        throw new AutopodError('Rework admission unavailable', 'REWORK_UNAVAILABLE', 503);
      journal.assertIdle(podId);
      if (legacyActive(podId))
        throw new AutopodError('Recovery is already running', 'RECOVERY_IN_PROGRESS', 409);
      repo.deletionOwnership?.assertTaskAvailable(podId);
      assertTaskExecutionTerminationVerified(repo.taskExecutions, podId);
      if (pod.options.agentMode === 'interactive' || pod.completionPolicy === 'accept-findings')
        throw new AutopodError(
          'Use the specialized workspace or findings controls',
          'REWORK_NOT_APPLICABLE',
          409,
        );
      if (
        !['failed', 'review_required', 'killed', 'validated'].includes(pod.status) ||
        pod.worktreeCompromised ||
        (pod.containerId && !pod.worktreePath)
      )
        throw new AutopodError(
          'Pod is not available for ordinary Rework',
          'REWORK_UNAVAILABLE',
          409,
        );
      if (pod.launchConfigDigest && !manager.getLaunchConfiguration)
        throw new AutopodError(
          'Effective launch inspection unavailable',
          'REWORK_UNAVAILABLE',
          503,
        );
      if (manager.getLaunchConfiguration?.(podId)?.intent === 'goal')
        throw new AutopodError('Use native Goal controls', 'GOAL_NATIVE_RESUME_REQUIRED', 409);
      const preview = manager.assertCanRework(podId);
      if (preview.notBefore && Date.parse(preview.notBefore) > Date.now())
        return {
          ...base,
          eligible: false,
          status: 'cooldown',
          reason: `Retry cooldown until ${preview.notBefore}`,
          notBefore: preview.notBefore,
        };
      return {
        ...base,
        eligible: true,
        status: preview.authorizationAvailable ? 'grant_recorded' : 'eligible',
        reason: preview.authorizationAvailable
          ? 'Usable one-use retry authorization recorded'
          : 'Eligible for Rework; admission will recheck current facts',
      };
    } catch (error) {
      if (!(error instanceof AutopodError)) throw error;
      return {
        ...base,
        eligible: false,
        status:
          error instanceof TaskRetryBlockedError && error.authorizationNeeded
            ? 'authorization_needed'
            : error.code === 'TASK_RETRY_BACKOFF_PENDING'
              ? 'cooldown'
              : 'blocked',
        reason: error.message,
      };
    }
  };
  app.get('/pods/:podId/rework-v1/eligibility', async (request, reply) => {
    actor(request);
    reply.header('Cache-Control', 'no-store');
    return inspect((request.params as { podId: string }).podId);
  });
  app.get('/pods/:podId/rework-v1/requests/:requestKey', async (request) => {
    actor(request);
    const { podId, requestKey } = request.params as { podId: string; requestKey: string };
    const receipt = journal?.read(requestKey);
    if (!receipt || receipt.podId !== podId)
      throw new AutopodError('Rework request not found', 'NOT_FOUND', 404);
    return receipt;
  });
  app.post('/pods/:podId/rework-v1', async (request, reply) => {
    const human = actor(request);
    const { podId } = request.params as { podId: string };
    const input = z
      .object({
        requestKey: z.string().uuid(),
        generation: z.number().int().min(0),
        guidance: z.string().max(16000).default(''),
      })
      .strict()
      .parse(request.body);
    if (!journal) throw new AutopodError('Durable Rework unavailable', 'REWORK_UNAVAILABLE', 503);
    const result = journal.accept(podId, input, human, () => {
      const eligibility = inspect(podId);
      if (!eligibility.eligible) throw new AutopodError(eligibility.reason, 'REWORK_BLOCKED', 409);
    });
    if (result.fresh) {
      // The journal is committed before any async preservation/teardown. Never dispatch on replay.
      void Promise.resolve()
        .then(() =>
          manager.triggerValidation(podId, {
            force: true,
            onReworkQueued: (generation) =>
              journal.queueForGeneration(podId, input.requestKey, generation),
          }),
        )
        .then(
          () => journal.settle(input.requestKey, null),
          (error: unknown) => {
            journal.settle(
              input.requestKey,
              error instanceof Error ? error.message : 'Rework dispatch failed; inspect pod state',
            );
            app.log.warn(
              { error, podId, requestKey: input.requestKey },
              'Durable Rework dispatch failed',
            );
          },
        )
        .catch((error: unknown) => {
          // A failed settlement write leaves the committed request unresolved.
          // Logging must not turn it into an unhandled rejection or a replay ticket.
          app.log.error(
            { error, podId, requestKey: input.requestKey },
            'Rework settlement remains unresolved',
          );
        });
    }
    reply.code(result.fresh ? 202 : 200);
    return result.receipt;
  });
  return { assertIdle: (podId: string) => journal?.assertIdle(podId) };
}
