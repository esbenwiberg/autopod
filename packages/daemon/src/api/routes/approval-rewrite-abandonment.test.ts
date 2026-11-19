import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { PodManager } from '../../pods/pod-manager.js';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { approvalRewriteAbandonmentRoutes } from './approval-rewrite-abandonment.js';

it('requires human auth, strict exact destructive selection and derives actor from authentication', async () => {
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  authPlugin(app, terminationAuth());
  const manager = {
    getApprovalRewriteAbandonment: vi.fn<PodManager['getApprovalRewriteAbandonment']>(async () => ({
      podId: 'fixture',
      generation: 2,
      rewriteId: 'rewrite',
      binding: 'a'.repeat(64),
      snapshot: { source: 'a'.repeat(64), resources: [], worktrees: [], pathIdentities: [] },
      warning: 'Data loss',
    })),
    abandonApprovalRewrite: vi.fn<PodManager['abandonApprovalRewrite']>(async () => ({
      podDeleted: true,
    })),
  };
  approvalRewriteAbandonmentRoutes(app, manager);
  const url = '/pods/fixture/approval-rewrite-abandonment';
  const headers = { authorization: 'Bearer human-token' };
  const body = {
    id: 'discard-request',
    expectedGeneration: 2,
    expectedBinding: 'a'.repeat(64),
    reason: 'Discard this exact selected rewrite',
    acknowledgeDataLoss: true,
  };
  try {
    for (const auth of [{}, { authorization: 'Bearer pod-token' }]) {
      expect((await app.inject({ url, headers: auth })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: 'POST', url, headers: auth, payload: body })).statusCode,
      ).toBe(401);
    }
    const inspected = await app.inject({ url, headers });
    expect(inspected.statusCode).toBe(200);
    expect(inspected.headers['cache-control']).toBe('no-store');
    for (const extra of [
      { acknowledgeDataLoss: false },
      { force: true },
      { actor: { type: 'human', userId: 'spoof' } },
      { expectedGeneration: 0 },
      { providerDeleted: true },
    ])
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: { ...body, ...extra } }))
          .statusCode,
      ).toBe(400);
    expect(manager.abandonApprovalRewrite).not.toHaveBeenCalled();
    const result = await app.inject({ method: 'POST', url, headers, payload: body });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ podDeleted: true });
    expect(manager.abandonApprovalRewrite).toHaveBeenCalledWith('fixture', body, {
      type: 'human',
      userId: expect.any(String),
    });
    expect(manager.abandonApprovalRewrite.mock.calls[0]?.[2]).not.toEqual({
      type: 'human',
      userId: 'spoof',
    });
  } finally {
    await app.close();
  }
});
