import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { PodManager } from '../../pods/index.js';
import { operatorTarget } from '../../pods/operator-target.js';
import { createOperatorFixture } from '../../test-utils/operator-helpers.js';
import { operatorActionRoutes } from './operator-actions.js';

describe('guarded operator routes', () => {
  it('uses actual message ownership guards and attributes delegated answers to automation', async () => {
    const f = createOperatorFixture(),
      question = f.awaiting(),
      waiter = f.waiter();
    const send = f.messages();
    const manager = {
      getSession: () => f.pod(),
      sendMessage: (...args: Parameters<PodManager['sendMessage']>) =>
        send.sendMessage.call(f.calls, ...args),
      nudgeSession: vi.fn(),
      approveSession: vi.fn(),
    } as unknown as PodManager;
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.user = { oid: 'fixture-user' } as typeof request.user;
    });
    operatorActionRoutes(app, manager);
    try {
      const inspected = await app.inject({
        method: 'GET',
        url: '/pods/prepare/operator-target-v1',
      });
      expect(inspected.statusCode).toBe(200);
      const body = {
        action: 'reply',
        actor: 'parent-session',
        expectedTarget: inspected.json().expectedTarget,
        message: 'Use the existing contract',
      };
      f.podRepo.update('prepare', {
        pendingEscalation: { ...question, payload: { question: 'Changed before admission' } },
      });
      const stale = await app.inject({
        method: 'POST',
        url: '/pods/prepare/operator-action-v1',
        payload: body,
      });
      expect(stale.statusCode).toBe(409);
      expect(f.pod().status).toBe('awaiting_input');
      body.expectedTarget = operatorTarget(f.pod()).expectedTarget;
      const fresh = await app.inject({
        method: 'POST',
        url: '/pods/prepare/operator-action-v1',
        payload: body,
      });
      expect(fresh.statusCode).toBe(200);
      await expect(waiter.wait).resolves.toBe(body.message);
      expect(f.deps.escalationRepo.getOrThrow(question.id).response).toMatchObject({
        respondedBy: 'ai',
        actor: { type: 'automation', id: 'operator:fixture-user:works:parent-session' },
      });
      expect(manager.approveSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
