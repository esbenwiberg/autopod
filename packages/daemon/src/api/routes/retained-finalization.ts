import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

export function retainedFinalizationRoutes(
  app: FastifyInstance,
  manager: Pick<PodManager, 'inspectRetainedFinalization' | 'finalizeRetained'>,
) {
  const params = z.object({ podId: z.string().min(1).max(128) }).strict();
  app.get('/pods/:podId/retained-finalization', async (request, reply) => {
    if (!request.user?.oid?.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return manager.inspectRetainedFinalization(podId);
  });
  app.post('/pods/:podId/retained-finalization', async (request, reply) => {
    if (!request.user?.oid?.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    const input = z
      .object({
        requestKey: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
        expectedGeneration: z.number().int().min(1),
        expectedBinding: z.string().regex(/^[a-f0-9]{64}$/),
        mode: z.enum(['stop-retain', 'complete-merged']),
        reason: z
          .string()
          .min(10)
          .max(4000)
          .refine((value) => value.trim().length >= 10),
      })
      .strict()
      .parse(request.body);
    const receipt = await manager.finalizeRetained(podId, input, {
      type: 'human',
      userId: request.user.oid,
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(receipt.state === 'pending' ? 202 : 200).send(receipt);
  });
}
