import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { validationHeldDockerRoutes } from './validation-held-docker-control.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
const url = '/pods/held-fixture/validation-held-docker';
const input = {
  requestKey: 'exact-stop',
  expectedGeneration: 1,
  expectedBinding: 'a'.repeat(64),
  mode: 'stop-retain',
  reason: 'Stop the exact owned execution and retain files',
};
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
  const result = {
    podId: 'held-fixture',
    state: 'unknown' as const,
    blockers: [],
    message: 'Observe exact request',
  };
  const manager = {
    inspectValidationHeldDocker: vi.fn(async () => result),
    observeValidationHeldDocker: vi.fn(() => result),
    stopValidationHeldDocker: vi.fn(async () => result),
  };
  validationHeldDockerRoutes(app, manager);
  await app.ready();
  return { app, manager };
}
it('requires a delegated human for preview, observation and Stop', async () => {
  const { app, manager } = await fixture();
  for (const token of [undefined, 'pod-token', 'app-only']) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    for (const target of [url, `${url}/exact-stop`])
      expect((await app.inject({ url: target, headers })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers, payload: input })).statusCode).toBe(
      401,
    );
  }
  expect(manager.stopValidationHeldDocker).not.toHaveBeenCalled();
});
it('rejects query/actor/force overrides and keeps observation read-only', async () => {
  const { app, manager } = await fixture(),
    headers = { authorization: 'Bearer human-token' };
  for (const payload of [
    { ...input, actor: { type: 'human', userId: 'spoof' } },
    { ...input, force: true },
    { ...input, mode: 'kill' },
  ])
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
  expect((await app.inject({ url: `${url}?force=true`, headers })).statusCode).toBe(400);
  expect((await app.inject({ url: `${url}/exact-stop`, headers })).statusCode).toBe(200);
  expect(manager.stopValidationHeldDocker).not.toHaveBeenCalled();
  const response = await app.inject({ method: 'POST', url, headers, payload: input });
  expect(response.statusCode).toBe(202);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(manager.stopValidationHeldDocker).toHaveBeenCalledWith(
    'held-fixture',
    input,
    expect.objectContaining({ type: 'human' }),
  );
});
