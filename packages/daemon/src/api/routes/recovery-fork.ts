import { AutopodError, recoveryForkInputSchema, recoveryForkRequestSchema } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/pod-manager.js';
import { RecoveryForkRejectedBeforeClaim } from '../../pods/recovery-fork-rejection.js';

export function recoveryForkRoutes(
  app: FastifyInstance,
  manager: Pick<
    PodManager,
    'inspectRecoveryFork' | 'previewRecoveryFork' | 'createRecoveryFork' | 'getRecoveryFork'
  >,
) {
  const params = z.object({ podId: z.string().min(1).max(128) }).strict();
  const operationParams = params
    .extend({ requestId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/) })
    .strict();
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.routeOptions.url?.includes('/recovery-fork'))
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/pods/:podId/recovery-fork', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.user?.oid?.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    z.object({}).strict().parse(request.query);
    return manager.inspectRecoveryFork(params.parse(request.params).podId);
  });
  app.post('/pods/:podId/recovery-fork/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.user?.oid?.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    z.object({}).strict().parse(request.query);
    return manager.previewRecoveryFork(
      params.parse(request.params).podId,
      recoveryForkInputSchema.parse(request.body),
    );
  });
  app.post('/pods/:podId/recovery-fork', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.user?.oid?.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    z.object({}).strict().parse(request.query);
    const { podId } = params.parse(request.params);
    const input = recoveryForkRequestSchema.parse(request.body);
    let result: Awaited<ReturnType<typeof manager.createRecoveryFork>>;
    try {
      result = await manager.createRecoveryFork(podId, input, {
        type: 'human',
        userId: request.user.oid,
      });
    } catch (error) {
      if (
        error instanceof RecoveryForkRejectedBeforeClaim &&
        error.parentPodId === podId &&
        error.requestId === input.id &&
        error.expectedBinding === input.expectedBinding
      )
        return reply.code(error.statusCode).send({
          code: error.code,
          parentPodId: podId,
          requestId: input.id,
          expectedBinding: input.expectedBinding,
          noOperationCreated: true,
          error: error.message,
          reasonCode: error.reasonCode,
        });
      throw error;
    }
    return reply
      .code(['preparing', 'queued', 'qualifying'].includes(result.state) ? 202 : 200)
      .send(result);
  });
  app.get('/pods/:podId/recovery-fork/:requestId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!request.user?.oid?.trim())
      throw new AutopodError('Authenticated human required', 'UNAUTHORIZED', 401);
    z.object({}).strict().parse(request.query);
    const { podId, requestId } = operationParams.parse(request.params);
    return manager.getRecoveryFork(podId, requestId);
  });
}
