import { AutopodError } from '@autopod/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { UnmeasuredUsageAcceptance } from '../../pods/unmeasured-usage-acceptance.js';
import { unmeasuredUsageRoutes } from './unmeasured-usage.js';

async function appFor(accept: UnmeasuredUsageAcceptance['accept'], oid = 'user-1') {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    request.user = { oid, roles: ['admin'] };
  });
  unmeasuredUsageRoutes(app, { accept });
  await app.ready();
  return app;
}

describe('accept-unmeasured-usage route', () => {
  it('forwards the authenticated principal, reason and attempt to the owner-only service', async () => {
    const accept = vi.fn().mockResolvedValue({ receipt: { id: 'r1' }, continuation: 'queued' });
    const app = await appFor(accept);

    const response = await app.inject({
      method: 'POST',
      url: '/pods/pod-1/accept-unmeasured-usage',
      payload: { reason: '  Refused before any model output  ', attempt: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ receipt: { id: 'r1' }, continuation: 'queued' });
    // Only the oid is forwarded: roles grant no bypass.
    expect(accept).toHaveBeenCalledWith(
      'pod-1',
      { reason: 'Refused before any model output', attemptOrdinal: 1 },
      { oid: 'user-1' },
    );
    await app.close();
  });

  it.each([
    [{}],
    [{ reason: 'short' }],
    [{ reason: 'Refused before any model output', attempt: 0 }],
    [{ reason: 'Refused before any model output', usage: 0 }],
  ])('rejects an invalid body %j with 400', async (payload) => {
    const accept = vi.fn();
    const app = await appFor(accept);

    const response = await app.inject({
      method: 'POST',
      url: '/pods/pod-1/accept-unmeasured-usage',
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(accept).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps a non-owner rejection to 403', async () => {
    const accept = vi
      .fn()
      .mockRejectedValue(new AutopodError('Only the pod owner may accept', 'FORBIDDEN', 403));
    const app = await appFor(accept, 'someone-else');

    const response = await app.inject({
      method: 'POST',
      url: '/pods/pod-1/accept-unmeasured-usage',
      payload: { reason: 'Refused before any model output' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Only the pod owner may accept', code: 'FORBIDDEN' });
    await app.close();
  });
});
