import { AutopodError, operatorDisposalRequestSchema } from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';
import type { PodRepository } from '../../pods/pod-repository.js';

export function operatorDisposalRoutes(
  app: FastifyInstance,
  manager: Pick<PodManager, 'submitOperatorDisposal' | 'observeOperatorDisposal'>,
  pods?: PodRepository,
) {
  const params = z.strictObject({ podId: z.string().min(1).max(128) });
  function actor(req: FastifyRequest) {
    if (
      !req.user?.oid?.trim() ||
      !['delegated-user', 'local-dev'].includes(req.user.operatorPrincipal ?? '')
    )
      throw new AutopodError('Authenticated operator required', 'UNAUTHORIZED', 401);
    if (Object.keys(req.query as object).length)
      throw new AutopodError('Query arguments unsupported', 'INVALID_REQUEST', 400);
    return { type: 'human' as const, userId: req.user.oid };
  }
  app.post('/pods/:podId/operator-disposal', async (req, reply) => {
    const human = actor(req);
    reply.header('Cache-Control', 'no-store');
    const r = manager.submitOperatorDisposal(
      params.parse(req.params).podId,
      operatorDisposalRequestSchema.parse(req.body),
      human,
    );
    return reply.code(202).send(r);
  });
  app.get('/pods/:podId/operator-disposal', async (req, reply) => {
    actor(req);
    reply.header('Cache-Control', 'no-store');
    const id = params.parse(req.params).podId;
    pods?.getOrThrow(id);
    return { receipt: pods?.operatorDisposals?.receipt(id) ?? null };
  });
  // Explicit observation may reconcile saved dispatches, but never replays uncertain effects.
  app.get('/pods/:podId/operator-disposal/:key', async (req, reply) => {
    actor(req);
    reply.header('Cache-Control', 'no-store');
    const p = params.extend({ key: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/) }).parse(req.params);
    return { receipt: pods?.operatorDisposals?.receipt(p.podId, p.key) ?? null };
  });
  app.post('/pods/:podId/operator-disposal/:key/observe', async (req, reply) => {
    actor(req);
    reply.header('Cache-Control', 'no-store');
    const p = params.extend({ key: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/) }).parse(req.params);
    return manager.observeOperatorDisposal(p.podId, p.key);
  });
}
