import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

export function artifactChecksRecoveryRoutes(
  app: FastifyInstance,
  manager: Pick<PodManager, 'inspectArtifactChecksRecovery' | 'recoverArtifactChecks'>,
) {
  const params = z.object({ podId: z.string().min(1).max(128) });
  const input = z
    .object({
      id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
      expectedBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
      reason: z.string().trim().min(10).max(4000),
    })
    .strict();
  app.get('/pods/:podId/artifact-checks-recovery', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'no-store');
    return manager.inspectArtifactChecksRecovery(params.parse(request.params).podId);
  });
  for (const suffix of ['', '/reconcile'])
    app.post(`/pods/:podId/artifact-checks-recovery${suffix}`, async (request, reply) => {
      if (!request.user?.oid)
        throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
      const operation = await manager.recoverArtifactChecks(
        params.parse(request.params).podId,
        input.parse(request.body),
        {
          type: 'human',
          userId: request.user.oid,
        },
      );
      reply.header('Cache-Control', 'no-store');
      return reply.code(202).send({ operation });
    });
}
