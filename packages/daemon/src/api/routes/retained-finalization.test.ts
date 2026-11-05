import type { RetainedFinalizationReceipt } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { retainedFinalizationRoutes } from './retained-finalization.js';

const input = {
  requestKey: 'request-1',
  expectedGeneration: 1,
  expectedBinding: 'a'.repeat(64),
  mode: 'stop-retain',
  reason: 'Cancel while preserving all source and reports',
} as const;
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler(errorHandler);
  authPlugin(app, terminationAuth());
  const receipt: RetainedFinalizationReceipt = {
    podId: 'pod',
    request: input,
    actor: { type: 'human', userId: 'operator' },
    state: 'pending',
    createdAt: new Date().toISOString(),
    finalizedAt: null,
    message: 'Observe pending stop',
    resourcesRetained: true,
  };
  const manager = {
    inspectRetainedFinalization: vi.fn(() => ({
      podId: 'pod',
      generation: 1,
      status: 'failed',
      binding: input.expectedBinding,
      custody: [],
      canStop: true,
      canCompleteMerged: false,
      blockers: [],
      operation: null,
    })),
    finalizeRetained: vi.fn(async () => receipt),
  };
  retainedFinalizationRoutes(app, manager);
  await app.ready();
  return { app, manager, receipt };
}
const url = '/pods/pod/retained-finalization';
const headers = { authorization: 'Bearer human-token' };
describe('human-only retained finalization API', () => {
  it.each(['GET', 'POST'] as const)('%s rejects anonymous and worker tokens', async (method) => {
    const f = await fixture();
    for (const token of [undefined, 'pod-token']) {
      const result = await f.app.inject({
        method,
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(method === 'POST' ? { payload: input } : {}),
      });
      expect(result.statusCode).toBe(401);
    }
    expect(f.manager.finalizeRetained).not.toHaveBeenCalled();
    expect(f.manager.inspectRetainedFinalization).not.toHaveBeenCalled();
  });
  it('reads without submission and returns exact pending/finalized receipts', async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: 'GET', url, headers })).statusCode).toBe(200);
    expect(f.manager.finalizeRetained).not.toHaveBeenCalled();
    const pending = await f.app.inject({ method: 'POST', url, headers, payload: input });
    expect(pending.statusCode).toBe(202);
    expect(pending.json()).toEqual(f.receipt);
    expect(pending.headers['cache-control']).toBe('no-store');
    expect(f.manager.finalizeRetained).toHaveBeenCalledWith('pod', input, {
      type: 'human',
      userId: 'operator-oid',
    });
    f.receipt.state = 'finalized';
    expect((await f.app.inject({ method: 'POST', url, headers, payload: input })).statusCode).toBe(
      200,
    );
  });
  it.each([
    { prUrl: 'https://arbitrary.invalid/pr' },
    { mode: 'kill' },
    { reason: '   ' },
    { expectedGeneration: 1.2 },
    { requestKey: '' },
    { expectedBinding: 'stale' },
    { actor: { type: 'human' } },
  ])('rejects strict invalid payload %j', async (change) => {
    const f = await fixture();
    expect(
      (await f.app.inject({ method: 'POST', url, headers, payload: { ...input, ...change } }))
        .statusCode,
    ).toBe(400);
    expect(f.manager.finalizeRetained).not.toHaveBeenCalled();
  });
});
