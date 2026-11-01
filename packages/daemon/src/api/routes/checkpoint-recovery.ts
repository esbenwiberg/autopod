import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

export function checkpointRecoveryRoutes(
  app: FastifyInstance,
  manager: Pick<PodManager, 'getCheckpointRecoveries' | 'recoverCheckpoint'>,
) {
  const params = z.object({ podId: z.string().min(1).max(128) });
  app.get('/pods/:podId/checkpoint-recovery', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return { operations: manager.getCheckpointRecoveries(podId) };
  });
  app.post('/pods/:podId/checkpoint-recovery', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    const input = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
        expectedGeneration: z.number().int().min(1),
        expectedResultHash: z.string().regex(/^[a-f0-9]{64}$/),
        checkpointHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        reason: z.string().trim().min(10).max(4000),
        setupCommand: z.string().trim().min(1).max(16000).optional(),
        resolveFailureOf: z
          .string()
          .regex(/^[a-zA-Z0-9-]{1,64}$/)
          .optional(),
      })
      .strict()
      .refine(
        (input) => !(input.resolveFailureOf && input.setupCommand !== undefined),
        'Resolution cannot also amend setup',
      )
      .parse(request.body);
    const operation = await manager.recoverCheckpoint(podId, input, {
      type: 'human',
      userId: request.user.oid,
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(input.resolveFailureOf ? 200 : 202).send({ operation });
  });
}
