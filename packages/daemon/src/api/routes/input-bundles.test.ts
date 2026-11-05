import { createHash, randomUUID } from 'node:crypto';
import { AuthError, AutopodError } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputBundleStore } from '../../inputs/input-bundle-store.js';
import { createTestDb } from '../../test-utils/mock-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { inputBundleRoutes } from './input-bundles.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function fixture() {
  const db = createTestDb();
  const store = new InputBundleStore(db);
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.addHook('preHandler', async (request) => {
    request.user = { oid: String(request.headers['x-owner'] ?? 'owner') } as typeof request.user;
  });
  await inputBundleRoutes(app, store);
  closers.push(async () => {
    await app.close();
    db.close();
  });
  return { app, store };
}
describe('owner-scoped reference uploads', () => {
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
    authPlugin(app, {
      validateToken: async (token) => {
        if (token !== 'operator') throw new AuthError('Invalid token');
        return user;
      },
      validateTokenSync: () => user,
    });
    await inputBundleRoutes(app, store);
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
    expect(download.rawPayload).toEqual(bytes);
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
    const { app } = await fixture();
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
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/input-bundles/missing/files/0',
          payload: { content: 'not raw bytes' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
