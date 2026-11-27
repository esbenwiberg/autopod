import { AutopodError } from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

export function savedWorkDraftRoutes(
  app: FastifyInstance,
  manager: Pick<
    PodManager,
    | 'inspectSavedWorkDraft'
    | 'prepareSavedWorkDraft'
    | 'confirmSavedWorkDraft'
    | 'observeSavedWorkDraft'
    | 'cancelSavedWorkDraft'
    | 'cancelSavedWorkDraftPreparation'
  >,
) {
  const actor = (r: FastifyRequest) => {
    if (!r.user?.oid?.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    return { type: 'human' as const, userId: r.user.oid };
  };
  const params = z.object({ podId: z.string().min(1).max(128) }).strict();
  const common = {
    requestId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
    expectedBinding: z.string().regex(/^[a-f0-9]{64}$/),
  };
  app.post('/pods/:podId/saved-work-draft/cancel-preparation', async (request, reply) => {
    const human = actor(request);
    const { podId } = params.parse(request.params);
    const body = z
      .object({ ...common, sourceId: z.string().min(1).max(160) })
      .strict()
      .parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return manager.cancelSavedWorkDraftPreparation(podId, body, human);
  });
  app.post('/pods/:podId/saved-work-draft/cancel', async (request, reply) => {
    const human = actor(request);
    const { podId } = params.parse(request.params);
    const body = z
      .object({ ...common, retireUncertainReason: z.string().trim().min(10).max(1000).optional() })
      .strict()
      .parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return manager.cancelSavedWorkDraft(podId, body, human);
  });
  app.get('/pods/:podId/saved-work-draft/:requestId', async (request, reply) => {
    const human = actor(request);
    const body = params.extend({ requestId: common.requestId }).parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return manager.observeSavedWorkDraft(body.podId, body.requestId, human);
  });
  app.get('/pods/:podId/saved-work-draft', async (request, reply) => {
    const human = actor(request);
    const { podId } = params.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return manager.inspectSavedWorkDraft(podId, human);
  });
  app.post('/pods/:podId/saved-work-draft/prepare', async (request, reply) => {
    const human = actor(request);
    const { podId } = params.parse(request.params);
    const body = z
      .object({ ...common, sourceId: z.string().min(1).max(160) })
      .strict()
      .parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return manager.prepareSavedWorkDraft(podId, body, human);
  });
  app.post('/pods/:podId/saved-work-draft/confirm', async (request, reply) => {
    const human = actor(request);
    const { podId } = params.parse(request.params);
    const body = z
      .object({ ...common, draftOnly: z.literal(true) })
      .strict()
      .parse(request.body);
    const op = await manager.confirmSavedWorkDraft(podId, body, human);
    reply.header('Cache-Control', 'no-store');
    return reply
      .code(['published', 'cancelled', 'retired-uncertain'].includes(op.state) ? 200 : 202)
      .send(op);
  });
}
