import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';

/** No force/actor/provider-proof fields, and no implicit inspect-and-delete. */
export function approvalRewriteAbandonmentRoutes(
  app: FastifyInstance,
  manager: Pick<PodManager, 'getApprovalRewriteAbandonment' | 'abandonApprovalRewrite'>,
) {
  const params = z.object({ podId: z.string().min(1).max(128) });
  const url = '/pods/:podId/approval-rewrite-abandonment';
  app.get(url, async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    reply.header('Cache-Control', 'no-store');
    return manager.getApprovalRewriteAbandonment(params.parse(request.params).podId);
  });
  app.post(url, async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    const input = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
        expectedGeneration: z.number().int().positive(),
        expectedBinding: z.string().regex(/^[a-f0-9]{64}$/),
        reason: z.string().trim().min(10).max(4000),
        acknowledgeDataLoss: z.literal(true),
      })
      .strict()
      .parse(request.body);
    reply.header('Cache-Control', 'no-store');
    return manager.abandonApprovalRewrite(params.parse(request.params).podId, input, {
      type: 'human',
      userId: request.user.oid,
    });
  });
}
