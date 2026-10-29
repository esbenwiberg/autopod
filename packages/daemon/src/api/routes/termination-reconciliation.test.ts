import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventRepository } from '../../pods/event-repository.js';
import {
  RECOVERY_REASON,
  terminationAuth,
  terminationFixture,
} from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { podRoutes } from './pods.js';

describe('termination reconciliation routes', () => {
  let ctx: ReturnType<typeof terminationFixture>;
  let app: ReturnType<typeof Fastify>;
  const headers = { authorization: 'Bearer human-token' };
  beforeEach(async () => {
    ctx = terminationFixture();
    app = Fastify();
    app.setErrorHandler(errorHandler);
    authPlugin(app, terminationAuth());
    podRoutes(app, ctx.manager, createEventRepository(ctx.db), undefined, ctx.podRepo);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    ctx.db.close();
  });

  const path = (podId: string) => `/pods/${podId}/termination-reconciliations`;

  it('inspects without probing or mutating, and submits only server-derived deletion evidence', async () => {
    const state = await app.inject({ method: 'GET', url: path(ctx.podId), headers });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      pending: [{ runId: ctx.runId, podId: ctx.podId }],
      receipts: [],
    });
    expect(ctx.containerManager.getStatus).not.toHaveBeenCalled();
    const payload = { runId: ctx.runId, reason: RECOVERY_REASON };
    const result = await app.inject({ method: 'POST', url: path(ctx.podId), headers, payload });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      actor: { type: 'human', userId: 'operator-oid' },
      proof: 'sandbox-deleted',
    });
    const retry = await app.inject({ method: 'POST', url: path(ctx.podId), headers, payload });
    expect(retry.json()).toEqual(result.json());
    expect(ctx.containerManager.getStatus).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'Bearer worker-hmac-token'])(
    'refuses absent/worker credentials: %s',
    async (authorization) => {
      const result = await app.inject({
        method: 'POST',
        url: path(ctx.podId),
        headers: authorization ? { authorization } : {},
        payload: { runId: ctx.runId, reason: RECOVERY_REASON },
      });
      expect(result.statusCode).toBe(401);
      expect(ctx.containerManager.getStatus).not.toHaveBeenCalled();
    },
  );

  it.each([
    { actor: { type: 'human', userId: 'spoofed-operator' } },
    { proof: 'sandbox-deleted' },
    { observedAt: '2026-10-27T00:00:00Z' },
    { reason: 'retry' },
    { runId: 'not-a-run-id' },
  ])('rejects invalid/spoofed input %j', async (extra) => {
    const result = await app.inject({
      method: 'POST',
      url: path(ctx.podId),
      headers,
      payload: { runId: ctx.runId, reason: RECOVERY_REASON, ...extra },
    });
    expect(result.statusCode, result.body).toBe(400);
    expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(true);
    expect(ctx.containerManager.getStatus).not.toHaveBeenCalled();
  });

  it('returns a conflict instead of releasing an unreachable sandbox claim', async () => {
    vi.mocked(ctx.containerManager.getStatus).mockResolvedValue('unknown');
    const result = await app.inject({
      method: 'POST',
      url: path(ctx.podId),
      headers,
      payload: { runId: ctx.runId, reason: RECOVERY_REASON },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe('TERMINATION_RECONCILIATION_REFUSED');
    expect(ctx.ledger.hasActiveRun(ctx.podId)).toBe(true);
  });
});
