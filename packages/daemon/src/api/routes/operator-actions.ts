import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PodManager } from '../../pods/index.js';
import { operatorTarget } from '../../pods/operator-target.js';

/** A separate versioned route fails closed against old daemons which strip unknown legacy fields. */
export function operatorActionRoutes(app: FastifyInstance, manager: PodManager): void {
  app.get('/pods/:podId/operator-target-v1', async (request, reply) => {
    const { podId } = z.object({ podId: z.string().min(1).max(128) }).parse(request.params);
    reply.header('Cache-Control', 'no-store');
    return operatorTarget(manager.getSession(podId));
  });
  app.post('/pods/:podId/operator-action-v1', async (request) => {
    const { podId } = z.object({ podId: z.string().min(1).max(128) }).parse(request.params);
    const body = z
      .object({
        action: z.enum(['reply', 'approve', 'nudge']),
        expectedTarget: z.string().regex(/^[a-f0-9]{64}$/),
        actor: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
        message: z.string().min(1).max(50_000).optional(),
      })
      .strict()
      .parse(request.body);
    if (body.action !== 'approve' && !body.message)
      throw new AutopodError('Message is required', 'MESSAGE_REQUIRED', 400);
    if (body.action === 'approve' && body.message !== undefined)
      throw new AutopodError(
        'Approval does not accept a message or waiver',
        'INVALID_APPROVAL_INPUT',
        400,
      );
    const actor = {
      type: 'automation' as const,
      id: `operator:${request.user.oid}:works:${body.actor}`,
    };
    // Owning methods check the expected identity synchronously at admission and
    // approval rechecks after asynchronous readiness/preparation. No human impersonation.
    if (body.action === 'reply')
      await manager.sendMessage(podId, body.message ?? '', actor, {
        expectedTarget: body.expectedTarget,
        backgroundCompletion: true,
      });
    else if (body.action === 'approve')
      await manager.approveSession(podId, {
        expectedTarget: body.expectedTarget,
        actor,
        automation: true,
      });
    else manager.nudgeSession(podId, body.message ?? '', body.expectedTarget);
    return { ok: true, action: body.action, expectedTarget: body.expectedTarget };
  });
}
