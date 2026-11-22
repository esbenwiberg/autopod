import type { RetainedCleanupReceipt } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { retainedCleanupRoutes } from './retained-cleanup.js';

const url = '/pods/pod/retained-cleanup';
const input = {
  id: 'request-id',
  expectedBinding: 'f'.repeat(64),
  expectedGeneration: 2,
  expectedSessionId: 'execution',
  reason: 'Explicitly discard its retained resources',
  acknowledgeDataLoss: true as const,
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler(errorHandler);
  const base = terminationAuth();
  authPlugin(app, {
    ...base,
    validateToken: async (token) => ({
      ...(await base.validateToken(token === 'app-only' ? 'human-token' : token)),
      ...(token === 'human-token' ? { operatorPrincipal: 'delegated-user' as const } : {}),
    }),
  });
  const receipt: RetainedCleanupReceipt = {
    podId: 'pod',
    request: input,
    actor: { type: 'human', userId: 'operator-oid' },
    state: 'partial',
    createdAt: 'now',
    updatedAt: 'now',
    resources: [],
    blockers: [],
    plan: {
      version: 1,
      generation: 2,
      sessionId: 'execution',
      binding: input.expectedBinding,
      resources: [],
      retained: [],
      notReclaimed: [],
      dataLoss: [],
    },
  };
  const manager = {
    inspectRetainedCleanup: vi.fn(async () => ({
      state: 'requested' as const,
      podId: 'pod',
      requestId: input.id,
    })),
    observeRetainedCleanup: vi.fn(() => receipt),
    submitRetainedCleanup: vi.fn(async () => receipt),
  };
  retainedCleanupRoutes(app, manager);
  await app.ready();
  return { app, manager, receipt };
}
const headers = { authorization: 'Bearer human-token' };
it('requires delegated human authority on preview, exact receipt and submission', async () => {
  const { app, manager } = await setup();
  for (const token of [undefined, 'pod-token', 'app-only']) {
    const h = token ? { authorization: 'Bearer ' + token } : {};
    expect((await app.inject({ url, headers: h })).statusCode).toBe(401);
    expect((await app.inject({ url: url + '/' + input.id, headers: h })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: h, payload: input })).statusCode).toBe(
      401,
    );
  }
  for (const method of Object.values(manager)) expect(method).not.toHaveBeenCalled();
});
it('requires exact actor-free request and explicit consent; GET is observation-only', async () => {
  const { app, manager, receipt } = await setup();
  for (const patch of [
    { force: true },
    { actor: 'viewer' },
    { path: '/tmp/unrelated' },
    { containerId: 'user-owned' },
    { acknowledgeDataLoss: false },
    { reason: '      ' },
    { expectedSessionId: undefined },
  ])
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { ...input, ...patch } }))
        .statusCode,
    ).toBe(400);
  const preview = await app.inject({ url, headers });
  const read = await app.inject({ url: url + '/' + input.id, headers });
  expect(preview.headers['cache-control']).toBe('no-store');
  expect(read.headers['cache-control']).toBe('no-store');
  expect(read.json()).toEqual(receipt);
  expect(manager.observeRetainedCleanup).toHaveBeenCalledWith('pod', input.id);
  expect(manager.submitRetainedCleanup).not.toHaveBeenCalled();
  for (const state of ['pending', 'partial', 'deleted'] as const) {
    receipt.state = state;
    const r = await app.inject({ method: 'POST', url, headers, payload: input });
    expect(r.statusCode).toBe(state === 'deleted' ? 200 : 202);
    expect(r.json()).toEqual(receipt);
    expect(r.headers['cache-control']).toBe('no-store');
  }
  expect(manager.submitRetainedCleanup).toHaveBeenCalledWith('pod', input, {
    type: 'human',
    userId: 'operator-oid',
  });
});
