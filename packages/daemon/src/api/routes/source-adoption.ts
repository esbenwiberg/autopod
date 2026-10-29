import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager-contracts.js';
const head = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
/** Durable status survives HTTP loss; repeating POST observes the original request, never relaunches. */
export function sourceAdoptionRoutes(
  app: FastifyInstance,
  manager: Pick<PodManager, 'adoptSource' | 'getSourceAdoptions'>,
) {
  app.get('/pods/:podId/source-adoptions', async (request) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    if (!manager.getSourceAdoptions)
      throw new AutopodError('Source recovery unavailable', 'SOURCE_RECOVERY_UNAVAILABLE', 503);
    const { podId } = request.params as { podId: string };
    return { operations: manager.getSourceAdoptions(podId) };
  });
  app.post('/pods/:podId/source-adoptions', async (request, reply) => {
    if (!request.user?.oid)
      throw new AutopodError('Authenticated human identity required', 'UNAUTHORIZED', 401);
    if (!manager.adoptSource)
      throw new AutopodError('Source recovery unavailable', 'SOURCE_RECOVERY_UNAVAILABLE', 503);
    const { podId } = request.params as { podId: string };
    const input = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),
        expectedGeneration: z.number().int().min(1),
        oldHeadSha: head,
        targetHeadSha: head,
        dependencySetupCommand: z.string().min(1).max(16000),
        reason: z.string().trim().min(10).max(4000),
      })
      .strict()
      .parse(request.body);
    const state = await manager.adoptSource(podId, input, {
      type: 'human',
      userId: request.user.oid,
    });
    return reply.code(state.stage === 'checked' ? 200 : 202).send(state);
  });
}
