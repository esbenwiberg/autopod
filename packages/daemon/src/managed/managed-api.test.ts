import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { managedPodRoutes } from '../api/routes/managed-pods.js';
import { fixture } from '../test-utils/managed-fixture.js';

it('authenticated start, passive observation and control preserve exact installation binding', async () => {
  const f = fixture();
  const app = Fastify();
  managedPodRoutes(app, {
    service: f.service(),
    authenticate: async (request) =>
      request.headers['x-fixture-auth'] === 'fixture' ? 'installation-one' : null,
  });
  try {
    expect(
      (await app.inject({ method: 'POST', url: '/managed/pods', payload: f.request })).statusCode,
    ).toBe(401);
    const headers = { 'x-fixture-auth': 'fixture' };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/managed/pods',
          headers,
          payload: { ...f.request, dispatcherInstallationId: 'other' },
        })
      ).statusCode,
    ).toBe(409);
    const response = await app.inject({
      method: 'POST',
      url: '/managed/pods',
      headers,
      payload: f.request,
    });
    expect(response.statusCode).toBe(200);
    const handle = response.json();
    expect(handle.dispatcherInstallationId).toBe('installation-one');
    const observed = await app.inject({
      method: 'GET',
      url: `/managed/pods/${handle.podId}/events?cursor=0`,
      headers,
    });
    expect(observed.json().events.map((event: { kind: string }) => event.kind)).toEqual([
      'queued',
      'running',
    ]);
    expect(f.launches()).toBe(1);
    const control = await app.inject({
      method: 'POST',
      url: `/managed/pods/${handle.podId}/control/stop-one`,
      headers,
      payload: {
        schemaVersion: 1,
        dispatcherAttemptId: handle.dispatcherAttemptId,
        grantId: handle.grantId,
        grantRevision: 1,
        operation: 'stop',
      },
    });
    expect(control.json()).toMatchObject({ stopRequested: true, observedExit: false });
  } finally {
    await app.close();
    f.close();
  }
});
