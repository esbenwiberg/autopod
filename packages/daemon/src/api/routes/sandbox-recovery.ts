import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

export function sandboxRecoveryRoutes(
  app: FastifyInstance,
  manager: Pick<PodManager, 'getSandboxRecovery' | 'recoverSandbox'>,
) {
  const params = z.object({ podId: z.string().min(1).max(128) });
  app.get('/pods/:podId/sandbox-recovery', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return { ...(await manager.getSandboxRecovery(podId)), currentUserId: request.user.oid };
  });
  app.post('/pods/:podId/sandbox-recovery', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const { podId } = params.parse(request.params);
    const input = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
        action: z.enum(['start', 'abandon']),
        sandboxId: z.string().min(1).max(128),
        expectedGeneration: z.number().int().min(1),
        expectedResourceKey: z.string().min(1).max(2048),
        reason: z.string().trim().min(10).max(4000),
        acknowledgeDataLoss: z.boolean(),
      })
      .strict()
      .parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return manager.recoverSandbox(podId, input, { type: 'human', userId: request.user.oid });
  });
}
