import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { AuthError, AutopodError, type InputBundleRef } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputBundleStore } from '../../inputs/input-bundle-store.js';
import { ReferencePreviewService } from '../../inputs/reference-preview-service.js';
import { createTestDb } from '../../test-utils/mock-helpers.js';
import { referencePreview } from '../../test-utils/reference-preview-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authenticateOperatorRequest, authPlugin } from '../plugins/auth.js';
import { inputBundleRoutes } from './input-bundles.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function fixture(previews?: (store: InputBundleStore) => ReferencePreviewService) {
  const db = createTestDb();
  const store = new InputBundleStore(db);
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.addHook('preHandler', async (request) => {
    request.user = { oid: String(request.headers['x-owner'] ?? 'owner') } as typeof request.user;
  });
  await inputBundleRoutes(app, store, previews?.(store), async (request) => {
    request.user = { oid: String(request.headers['x-owner'] ?? 'owner') } as typeof request.user;
  });
  closers.push(async () => {
    await app.close();
    db.close();
  });
  return { app, store };
}
async function authenticatedNetworkFixture(bodyTimeout = 30_000) {
  const db = createTestDb();
  const store = new InputBundleStore(db);
  const app = Fastify();
  const user = {
    oid: 'owner',
    preferred_username: 'owner',
    name: 'Owner',
    roles: [],
    aud: '',
    iss: '',
    exp: 9999999999,
    iat: 0,
  };
  const auth = {
    validateToken: vi.fn(async (token: string) => {
      if (token !== 'operator') throw new AuthError('Invalid token');
      return user;
    }),
    validateTokenSync: () => user,
  };
  app.setErrorHandler(errorHandler);
  authPlugin(app, auth);
  await inputBundleRoutes(
    app,
    store,
    undefined,
    (request) => authenticateOperatorRequest(request, auth),
    bodyTimeout,
  );
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  closers.push(async () => {
    await app.close();
    db.close();
  });
  const bytes = Buffer.from('<p>Reference</p>');
  const bundle = store.create(
    {
      requestKey: randomUUID(),
      files: [
        {
          path: 'design.html',
          mediaType: 'text/html',
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    },
    'owner',
  );
  const url = `/input-bundles/${bundle.id}/files/0`;
  function stalled(token?: string) {
    const req = httpRequest(`${address}${url}`, {
      method: 'PUT',
      agent: false,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': bytes.length,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    const status = new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('No early upload response')), 2000);
      req.on('response', (response) => {
        response.resume();
        response.once('end', () => {
          clearTimeout(deadline);
          resolve(response.statusCode ?? 0);
        });
      });
      req.on('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    void status.catch(() => {});
    const closed = new Promise<void>((resolve) => req.once('close', () => resolve()));
    req.write(bytes.subarray(0, 1));
    return { req, status, closed };
  }
  return { app, store, auth, bytes, bundle, url, stalled };
}

describe('owner-scoped reference uploads', () => {
  it('rejects four unauthenticated unfinished PUT bodies before reserving upload capacity', async () => {
    const f = await authenticatedNetworkFixture();
    const stalled = Array.from({ length: 4 }, () => f.stalled());
    try {
      expect(await Promise.all(stalled.map((entry) => entry.status))).toEqual([401, 401, 401, 401]);
      const valid = await f.app.inject({
        method: 'PUT',
        url: f.url,
        headers: { authorization: 'Bearer operator', 'content-type': 'application/octet-stream' },
        payload: f.bytes,
      });
      expect(valid.statusCode).toBe(204);
      f.store.seal(f.bundle.id, 'owner');
      expect(f.store.read(f.bundle.id, 'owner', 0)).toEqual(f.bytes);
    } finally {
      for (const entry of stalled) entry.req.destroy();
    }
  });
  it('expires authenticated stalled bodies and releases all four slots', async () => {
    const f = await authenticatedNetworkFixture(500);
    const stalled = Array.from({ length: 4 }, () => f.stalled('operator'));
    try {
      for (let count = 0; count < 30 && f.auth.validateToken.mock.calls.length < 4; count++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setImmediate(resolve));
      const request = {
        method: 'PUT' as const,
        url: f.url,
        headers: { authorization: 'Bearer operator', 'content-type': 'application/octet-stream' },
        payload: f.bytes,
      };
      expect((await f.app.inject(request)).statusCode).toBe(429);
      await Promise.all(stalled.map((entry) => entry.closed));
      expect((await f.app.inject(request)).statusCode).toBe(204);
    } finally {
      for (const entry of stalled) entry.req.destroy();
    }
  });
  it('returns only owner-authorized source-bound raster previews, never active HTML', async () => {
    const image = `sha256:${'a'.repeat(64)}`;
    const render = vi.fn(async (ref: InputBundleRef, path: string) =>
      referencePreview(ref, path, image),
    );
    const { app, store } = await fixture(
      (store) => new ReferencePreviewService(store, { image, render }),
    );
    const bytes = Buffer.from('<!doctype html><h1>Untrusted source</h1>');
    const bundle = store.create(
      {
        requestKey: randomUUID(),
        files: [
          {
            path: 'design.html',
            mediaType: 'text/html',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      'owner',
    );
    store.put(bundle.id, 'owner', 0, bytes);
    store.seal(bundle.id, 'owner');
    const url = `/input-bundles/${bundle.id}/render`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-owner': 'other' },
          payload: { path: 'design.html' },
        })
      ).statusCode,
    ).toBe(404);
    expect(render).not.toHaveBeenCalled();
    const rendered = await app.inject({ method: 'POST', url, payload: { path: 'design.html' } });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.json().receipt.mediaType).toBe('image/jpeg');
    expect(rendered.headers['cache-control']).toContain('private');
    expect(rendered.headers['content-type']).toContain('application/json');
    expect(rendered.body).not.toContain('Untrusted source');
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: { path: 'design.html', url: 'http://localhost/' },
        })
      ).statusCode,
    ).toBe(400);
    expect(render).toHaveBeenCalledTimes(1);
  });
  it('fails explicitly when isolated rendering is unavailable without revealing other owners', async () => {
    const { app, store } = await fixture();
    const bytes = Buffer.from('<p>Reference</p>');
    const bundle = store.create(
      {
        requestKey: randomUUID(),
        files: [
          {
            path: 'design.html',
            mediaType: 'text/html',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      'owner',
    );
    const url = `/input-bundles/${bundle.id}/render`;
    expect(
      (await app.inject({ method: 'POST', url, payload: { path: 'design.html' } })).json().error,
    ).toBe('REFERENCE_RENDER_UNAVAILABLE');
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'x-owner': 'other' },
          payload: { path: 'design.html' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('inherits operator authentication and does not admit pod tokens', async () => {
    const db = createTestDb();
    const store = new InputBundleStore(db);
    const app = Fastify();
    const user = {
      oid: 'owner',
      preferred_username: 'owner',
      name: 'Owner',
      roles: [],
      aud: '',
      iss: '',
      exp: 9999999999,
      iat: 0,
    };
    app.setErrorHandler(errorHandler);
    const auth = {
      validateToken: async (token: string) => {
        if (token !== 'operator') throw new AuthError('Invalid token');
        return user;
      },
      validateTokenSync: () => user,
    };
    authPlugin(app, auth);
    await inputBundleRoutes(app, store, undefined, (request) =>
      authenticateOperatorRequest(request, auth),
    );
    closers.push(async () => {
      await app.close();
      db.close();
    });
    expect((await app.inject({ method: 'GET', url: '/input-bundles/missing' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/input-bundles/missing',
          headers: { authorization: 'Bearer pod-token' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/input-bundles/missing',
          headers: { authorization: 'Bearer operator' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('uploads above the JSON body cap, seals exact bytes, and downloads as inert data', async () => {
    const { app } = await fixture();
    const bytes = Buffer.from(`<script>alert('untrusted')</script>${'x'.repeat(2 * 1024 * 1024)}`);
    const created = await app.inject({
      method: 'POST',
      url: '/input-bundles',
      payload: {
        requestKey: randomUUID(),
        files: [
          {
            path: 'wireframe.html',
            mediaType: 'text/html',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const bundle = created.json();
    const upload = await app.inject({
      method: 'PUT',
      url: `/input-bundles/${bundle.id}/files/0`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(upload.statusCode).toBe(204);
    const seal = await app.inject({ method: 'POST', url: `/input-bundles/${bundle.id}/seal` });
    expect(seal.json().status).toBe('sealed');
    const download = await app.inject({
      method: 'GET',
      url: `/input-bundles/${bundle.id}/files/0`,
    });
    // Compare every byte natively, without a multi-million-element JS deep equality walk.
    expect(download.rawPayload.equals(bytes)).toBe(true);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-type']).toBe('application/octet-stream');
    expect(download.headers['content-security-policy']).toContain('sandbox');
    const forbidden = await app.inject({
      method: 'GET',
      url: `/input-bundles/${bundle.id}`,
      headers: { 'x-owner': 'other' },
    });
    expect(forbidden.statusCode).toBe(404);
    const oversized = await app.inject({
      method: 'PUT',
      url: `/input-bundles/${bundle.id}/files/0`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    expect(oversized.statusCode).toBe(413);
    expect(app.initialConfig.bodyLimit).toBe(1024 * 1024);
  });
  it('preserves quota diagnostics rather than misreporting a file size error', async () => {
    const { app, store } = await fixture();
    vi.spyOn(store, 'create').mockImplementation(() => {
      throw new AutopodError(
        'Reference attachment storage quota reached',
        'INPUT_QUOTA_EXCEEDED',
        413,
      );
    });
    const response = await app.inject({ method: 'POST', url: '/input-bundles', payload: {} });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('INPUT_QUOTA_EXCEEDED');
    expect(response.json().message).toContain('quota');
  });

  it('rejects missing bytes, unsafe paths and invalid upload types', async () => {
    const { app, store } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/input-bundles',
      payload: {
        requestKey: randomUUID(),
        files: [
          {
            path: '../wireframe.html',
            mediaType: 'text/html',
            byteLength: 0,
            sha256: '0'.repeat(64),
          },
        ],
      },
    });
    expect(created.statusCode).toBe(400);
    const admitted = store.create(
      {
        requestKey: randomUUID(),
        files: [
          { path: 'design.txt', mediaType: 'text/plain', byteLength: 1, sha256: '0'.repeat(64) },
        ],
      },
      'owner',
    );
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/input-bundles/${admitted.id}/files/0`,
          payload: { content: 'not raw bytes' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
