import type { OperatorActor } from '@autopod/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { PodManager } from '../../pods/pod-manager.js';
import { podRoutes } from './pods.js';

describe('authenticated findings acceptance transport', () => {
  it('passes strict exact evidence and authenticated actor to a separate control', async () => {
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      request.user = { oid: 'authenticated-reviewer', name: 'Reviewer' } as typeof request.user;
    });
    const acceptFindings = vi.fn(async (_id: string, _body: unknown, _actor: OperatorActor) => ({
      accepted: true,
    }));
    const approveSession = vi.fn();
    podRoutes(app, { acceptFindings, approveSession } as unknown as PodManager);
    const body = { expectedGeneration: 2, expectedCycle: 3, expectedEvidenceHash: 'a'.repeat(64) };
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/pods/exact-pod/accept-findings',
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(acceptFindings).toHaveBeenCalledExactlyOnceWith('exact-pod', body, {
        type: 'human',
        userId: 'authenticated-reviewer',
        displayName: 'Reviewer',
      });
      expect(approveSession).not.toHaveBeenCalled();
      acceptFindings.mockClear();
      for (const invalid of [
        {},
        { ...body, actor: { type: 'human', userId: 'forged' } },
        { ...body, expectedCycle: -1 },
        { ...body, expectedEvidenceHash: 'invalid' },
      ]) {
        const rejected = await app.inject({
          method: 'POST',
          url: '/pods/exact-pod/accept-findings',
          payload: invalid,
        });
        expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(acceptFindings).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
