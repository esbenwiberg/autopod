import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';

const plan = vi.fn();
const release = vi.fn();
vi.mock('../../containers/retained-network-release.js', () => ({
  planRetainedNetworkReleases: (...args: unknown[]) => plan(...args),
  releaseRetainedNetworks: (...args: unknown[]) => release(...args),
}));
const { retainedNetworkRoutes } = await import('./retained-networks.js');

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  plan.mockReset();
  release.mockReset();
});
async function fixture() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler(errorHandler);
  authPlugin(app, terminationAuth());
  retainedNetworkRoutes(app, { docker: {} as never, db: {} as never });
  await app.ready();
  return app;
}
const human = { authorization: 'Bearer human-token' };

describe('retained network release routes', () => {
  it('requires user authentication', async () => {
    const app = await fixture();
    expect(
      (await app.inject({ method: 'GET', url: '/maintenance/retained-networks' })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/maintenance/retained-networks/release',
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(release).not.toHaveBeenCalled();
  });

  it('serves a read-only plan', async () => {
    plan.mockResolvedValue([
      { identity: 'a', eligible: true },
      { identity: 'b', eligible: false, reason: 'held' },
    ]);
    const app = await fixture();
    const res = await app.inject({
      method: 'GET',
      url: '/maintenance/retained-networks',
      headers: human,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      eligible: 1,
      candidates: [{ identity: 'a' }, { identity: 'b' }],
    });
    expect(release).not.toHaveBeenCalled();
  });

  it('releases with the authenticated operator as actor and a bounded limit', async () => {
    release.mockResolvedValue([
      { identity: 'a', outcome: 'removed' },
      { identity: 'b', outcome: 'failed' },
    ]);
    const app = await fixture();
    const res = await app.inject({
      method: 'POST',
      url: '/maintenance/retained-networks/release',
      headers: human,
      payload: { limit: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ released: 1 });
    expect(release).toHaveBeenCalledWith(expect.anything(), {
      limit: 2,
      actor: { type: 'human', userId: 'operator-oid' },
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/maintenance/retained-networks/release',
      headers: human,
      payload: { limit: 0 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
