import {
  AutopodError,
  retainedCleanupRequestIdSchema,
  retainedCleanupRequestSchema,
} from '@autopod/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

export function retainedCleanupRoutes(
  app: FastifyInstance,
  manager: Pick<
    PodManager,
    'inspectRetainedCleanup' | 'submitRetainedCleanup' | 'observeRetainedCleanup'
  >,
) {
  const pod = z.strictObject({ podId: z.string().min(1).max(128) });
  const exact = pod.extend({ requestId: retainedCleanupRequestIdSchema });
  function human(request: FastifyRequest, reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const user = request.user;
    if (
      !user?.oid?.trim() ||
      (user.operatorPrincipal !== 'delegated-user' && user.operatorPrincipal !== 'local-dev')
    )
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    if (Object.keys(request.query as object).length)
      throw new AutopodError(
        'Retained cleanup does not accept query arguments',
        'INVALID_REQUEST',
        400,
      );
    return { type: 'human' as const, userId: user.oid };
  }
  app.get('/pods/:podId/retained-cleanup', async (request, reply) => {
    human(request, reply);
    return manager.inspectRetainedCleanup(pod.parse(request.params).podId);
  });
  app.post('/pods/:podId/retained-cleanup', async (request, reply) => {
    const actor = human(request, reply);
    const result = await manager.submitRetainedCleanup(
      pod.parse(request.params).podId,
      retainedCleanupRequestSchema.parse(request.body),
      actor,
    );
    return reply
      .code(result.state === 'pending' || result.state === 'partial' ? 202 : 200)
      .send(result);
  });
  app.get('/pods/:podId/retained-cleanup/:requestId', async (request, reply) => {
    human(request, reply);
    const { podId, requestId } = exact.parse(request.params);
    return manager.observeRetainedCleanup(podId, requestId);
  });
}
