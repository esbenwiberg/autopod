import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { managedPodRoutes } from '../api/routes/managed-pods.js';
import { fixture, resign } from '../test-utils/managed-fixture.js';

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

it('lists managed pods with installation scoping, passive diagnostics and stable pagination', async () => {
  const f = fixture();
  const app = Fastify();
  managedPodRoutes(app, {
    service: f.service(),
    authenticate: async (request) => {
      if (request.headers['x-fixture-auth'] === 'fixture') return 'installation-one';
      if (request.headers['x-fixture-auth'] === 'other') return 'other';
      return null;
    },
  });
  try {
    const first = await f.service().start('installation-one', f.request);
    f.db
      .prepare(
        `INSERT INTO managed_provider_requests
          (pod_id,operation_key,request_digest,transport_digest,grant_revision,state,actual_tokens,
           failure_phase,failure_reason,failure_http_status)
         VALUES (?,?,?,?,?,'observed',?,?,?,?)`,
      )
      .run(
        first.podId,
        'request-one',
        'request-digest',
        'transport-digest',
        1,
        42,
        'http',
        'http',
        429,
      );
    f.db
      .prepare(
        `INSERT INTO artifact_exports
          (artifact_id,pod_id,dispatcher_attempt_id,execution_spec_digest,status,manifest_json,
           manifest_sha256,bundle_sha256,bundle_bytes,blob_manifest_name,blob_bundle_name,file_count,
           total_bytes,created_at,committed_at,receipt_json)
         VALUES (?,?,?,?,?,'{}','sha256:manifest','sha256:bundle',x'',?,?,2,64,100,101,'{}')`,
      )
      .run(
        'artifact-one',
        first.podId,
        first.dispatcherAttemptId,
        first.acceptedExecutionSpecDigest,
        'committed',
        'managed-pods/one/manifest.json',
        'managed-pods/one/bundle.tar.gz',
      );
    f.db
      .prepare(
        'UPDATE managed_pods SET consumed_tokens=42,observed_exit=1,exit_code=7 WHERE pod_id=?',
      )
      .run(first.podId);

    const requestTwo = structuredClone(f.request);
    requestTwo.dispatcherAttemptId = 'attempt-two';
    requestTwo.effectiveGrant.dispatcherAttemptId = 'attempt-two';
    requestTwo.startKey = 'start-two';
    resign(requestTwo);
    f.advance(101);
    const second = await f.service().start('installation-one', requestTwo);
    const foreignRequest = structuredClone(f.request);
    foreignRequest.dispatcherAttemptId = 'attempt-foreign';
    foreignRequest.effectiveGrant.dispatcherAttemptId = 'attempt-foreign';
    foreignRequest.startKey = 'start-foreign';
    resign(foreignRequest);
    await f.service().start('other', foreignRequest);

    expect((await app.inject('/managed/pods')).statusCode).toBe(401);
    const firstPage = await app.inject({
      method: 'GET',
      url: '/managed/pods?limit=1',
      headers: { 'x-fixture-auth': 'fixture' },
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json().pods.map((pod: { podId: string }) => pod.podId)).toEqual([
      second.podId,
    ]);
    const secondPage = await app.inject({
      method: 'GET',
      url: `/managed/pods?limit=1&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: { 'x-fixture-auth': 'fixture' },
    });
    expect(secondPage.json()).toMatchObject({
      schemaVersion: 1,
      nextCursor: null,
      pods: [
        {
          podId: first.podId,
          dispatcherAttemptId: first.dispatcherAttemptId,
          providerRequests: 1,
          consumedTokens: 42,
          tokenUsageKnown: true,
          failure: { phase: 'http', reason: 'http', httpStatus: 429 },
          artifacts: [
            { artifactId: 'artifact-one', status: 'committed', fileCount: 2, totalBytes: 64 },
          ],
          observedExit: true,
          exitCode: 7,
        },
      ],
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/managed/pods',
          headers: { 'x-fixture-auth': 'other' },
        })
      )
        .json()
        .pods.map((pod: { dispatcherAttemptId: string }) => pod.dispatcherAttemptId),
    ).toEqual(['attempt-foreign']);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/managed/pods?limit=0',
          headers: { 'x-fixture-auth': 'fixture' },
        })
      ).statusCode,
    ).toBe(400);
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
