import { AutopodError, validationHeldStopRequestSchema } from '@autopod/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

export function validationHeldDockerRoutes(
  app: FastifyInstance,
  manager: Pick<
    PodManager,
    'inspectValidationHeldDocker' | 'observeValidationHeldDocker' | 'stopValidationHeldDocker'
  >,
) {
  const params = z.strictObject({ podId: z.string().min(1).max(128) });
  function human(req: FastifyRequest, reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    if (
      !req.user?.oid?.trim() ||
      !['delegated-user', 'local-dev'].includes(req.user.operatorPrincipal ?? '')
    )
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    if (Object.keys(req.query as object).length)
      throw new AutopodError('Query arguments are not supported', 'INVALID_REQUEST', 400);
    return { type: 'human' as const, userId: req.user.oid };
  }
  app.get('/pods/:podId/validation-held-docker', async (req, reply) => {
    human(req, reply);
    return manager.inspectValidationHeldDocker(params.parse(req.params).podId);
  });
  app.get('/pods/:podId/validation-held-docker/:key', async (req, reply) => {
    human(req, reply);
    const p = params.extend({ key: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/) }).parse(req.params);
    return manager.observeValidationHeldDocker(p.podId, p.key);
  });
  app.post('/pods/:podId/validation-held-docker', async (req, reply) => {
    const actor = human(req, reply);
    const r = await manager.stopValidationHeldDocker(
      params.parse(req.params).podId,
      validationHeldStopRequestSchema.parse(req.body),
      actor,
    );
    return reply.code(['unknown', 'pending'].includes(r.state) ? 202 : 200).send(r);
  });
}
