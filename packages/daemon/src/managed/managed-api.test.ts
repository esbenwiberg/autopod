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

it('serializes an absent managed attempt as JSON null for the CLI', async () => {
  const f = fixture();
  const app = Fastify();
  managedPodRoutes(app, { service: f.service(), authenticate: async () => 'installation-one' });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/managed/reconcile-start',
      payload: f.request,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('null');
    expect(response.headers['content-type']).toContain('application/json');
    expect(f.launches()).toBe(0);
  } finally {
    await app.close();
    f.close();
  }
});

it('passively looks up an attempt within its authenticated installation after expiry', async () => {
  const f = fixture();
  const app = Fastify();
  managedPodRoutes(app, {
    service: f.service(),
    authenticate: async (request) =>
      request.headers['x-fixture-auth'] === 'other' ? 'other' : 'installation-one',
  });
  try {
    const url = `/managed/attempts/${f.request.dispatcherAttemptId}`;
    expect((await app.inject({ method: 'GET', url })).json()).toBeNull();
    await expect(
      f.service().start('installation-one', f.request, 'after-reservation'),
    ).rejects.toThrow();
    f.advance(4102444801);
    await f.service().enforceExpiry();
    const response = await app.inject({ method: 'GET', url });
    expect(response.json().dispatcherAttemptId).toBe(f.request.dispatcherAttemptId);
    expect(
      (await app.inject({ method: 'GET', url, headers: { 'x-fixture-auth': 'other' } })).json(),
    ).toBeNull();
    expect(f.launches()).toBe(0);
  } finally {
    await app.close();
    f.close();
  }
});

it('cleans an expired unallocated reservation only with explicit runtime absence proof', async () => {
  const f = fixture();
  const app = Fastify();
  const service = f.service();
  managedPodRoutes(app, { service, authenticate: async () => 'installation-one' });
  try {
    await expect(
      service.start('installation-one', f.request, 'after-reservation'),
    ).rejects.toThrow();
    f.advance(4102444801);
    await service.enforceExpiry();
    const handle = await service.reconcileStart('installation-one', f.request);
    const call = {
      method: 'POST' as const,
      url: `/managed/pods/${handle?.podId}/control/cleanup-unallocated`,
      payload: {
        schemaVersion: 1,
        dispatcherAttemptId: f.request.dispatcherAttemptId,
        grantId: f.request.effectiveGrant.grantId,
        grantRevision: 1,
        operation: 'cleanup',
      },
    };
    expect((await app.inject(call)).statusCode).toBe(409);
    f.runtime.cleanupUnallocated = async () => true;
    expect((await app.inject(call)).json().cleanup).toBe('observed');
    expect(f.launches()).toBe(0);
  } finally {
    await app.close();
    f.close();
  }
});
