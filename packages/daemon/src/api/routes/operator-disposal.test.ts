import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { operatorDisposalRoutes } from './operator-disposal.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function fixture() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler(errorHandler);
  const auth = terminationAuth();
  authPlugin(app, {
    ...auth,
    validateToken: async (token) => ({
      ...(await auth.validateToken(token === 'app-only' ? 'human-token' : token)),
      ...(token === 'human-token' ? { operatorPrincipal: 'delegated-user' as const } : {}),
    }),
  });
  const receipt = {
    contract: 'operator-disposal-v1' as const,
    podId: 'exact-pod',
    generation: 1,
    requestKey: 'request',
    intent: 'kill' as const,
    actor: { type: 'human' as const, userId: 'operator-oid' },
    acceptedAt: 'now',
    scope: 'exact-pod-unpublished-resources' as const,
    state: 'cleanup_pending' as const,
    diagnostics: [],
  };
  const manager = {
    submitOperatorDisposal: vi.fn(() => receipt),
    observeOperatorDisposal: vi.fn(async () => receipt),
  };
  operatorDisposalRoutes(app, manager);
  await app.ready();
  return { app, manager };
}
const url = '/pods/exact-pod/operator-disposal';
const input = { requestKey: 'request', expectedGeneration: 1, intent: 'kill' };
const headers = { authorization: 'Bearer human-token' };
it('requires authenticated operator rather than worker/app credentials', async () => {
  const { app, manager } = await fixture();
  for (const token of [undefined, 'pod-token', 'app-only']) {
    const h = token ? { authorization: `Bearer ${token}` } : {};
    expect((await app.inject({ method: 'POST', url, headers: h, payload: input })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ url, headers: h })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: `${url}/request/observe`, headers: h })).statusCode,
    ).toBe(401);
  }
  expect(manager.submitOperatorDisposal).not.toHaveBeenCalled();
});
it('returns distinct 202 acceptance, authenticates actor and rejects bypass or loss of Delete consent', async () => {
  const { app, manager } = await fixture();
  for (const patch of [
    { force: true },
    { actor: 'forged' },
    { containerId: 'foreign' },
    { intent: 'delete' },
  ]) {
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: { ...input, ...patch } }))
        .statusCode,
    ).toBe(400);
  }
  expect(manager.submitOperatorDisposal).not.toHaveBeenCalled();
  const result = await app.inject({ method: 'POST', url, headers, payload: input });
  expect(result.statusCode).toBe(202);
  expect(result.json()).toMatchObject({
    contract: 'operator-disposal-v1',
    state: 'cleanup_pending',
  });
  expect(manager.submitOperatorDisposal).toHaveBeenCalledWith('exact-pod', input, {
    type: 'human',
    userId: 'operator-oid',
  });
  expect(result.headers['cache-control']).toBe('no-store');
});
