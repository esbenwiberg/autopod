import {
  AutopodError,
  repairContinuationPreviewQueryV1Schema,
  repairContinuationRequestV1Schema,
} from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

/** Separate protocol: old daemons 404, never silently fall back to destructive Rework. */
export function repairContinuationRoutes(
  app: FastifyInstance,
  manager: Pick<
    PodManager,
    | 'inspectRepairContinuation'
    | 'previewRepairContinuation'
    | 'authorizeRepairContinuation'
    | 'getRepairContinuation'
  >,
) {
  const params = z.object({ podId: z.string().min(1).max(128) });
  function human(request: { user?: { oid?: string } }) {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    return { type: 'human' as const, userId: request.user.oid };
  }
  app.get('/pods/:podId/repair-continuation-v1', async (request, reply) => {
    human(request);
    reply.header('Cache-Control', 'no-store');
    return manager.inspectRepairContinuation(params.parse(request.params).podId);
  });
  app.get('/pods/:podId/repair-continuation-v1/preview', async (request, reply) => {
    human(request);
    reply.header('Cache-Control', 'no-store');
    return manager.previewRepairContinuation(
      params.parse(request.params).podId,
      repairContinuationPreviewQueryV1Schema.parse(request.query),
    );
  });
  app.post('/pods/:podId/repair-continuation-v1', async (request, reply) => {
    const actor = human(request);
    const podId = params.parse(request.params).podId;
    const input = repairContinuationRequestV1Schema.parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return reply.code(202).send(await manager.authorizeRepairContinuation(podId, input, actor));
  });
  app.get('/pods/:podId/repair-continuation-v1/requests/:requestId', async (request, reply) => {
    human(request);
    reply.header('Cache-Control', 'no-store');
    const { podId, requestId } = params
      .extend({ requestId: repairContinuationRequestV1Schema.shape.id })
      .parse(request.params);
    return manager.getRepairContinuation(podId, requestId);
  });
}
