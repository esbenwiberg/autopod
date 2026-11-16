import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthError } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { resolveLaunch } from '../../configuration/launch-resolver.js';
import { createPodTokenIssuer } from '../../crypto/pod-tokens.js';
import { InputBundleStore } from '../../inputs/input-bundle-store.js';
import { createTestConfiguration, insertConfigurationTestPod } from '../../test-utils/configuration-helpers.js';
import { createTestDb } from '../../test-utils/mock-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authenticateOperatorRequest, authPlugin } from '../plugins/auth.js';
import { configurationRoutes } from './configuration.js';
import { inputBundleRoutes } from './input-bundles.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const db = createTestDb();
  const store = new InputBundleStore(db);
  const { services } = createTestConfiguration(db);
  services.assertInputBundle = (ref, owner) => store.assert(ref, owner ?? '');
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  const directory = mkdtempSync(path.join(tmpdir(), 'shared-input-auth-'));
  const key = path.join(directory, 'key');
  writeFileSync(key, Buffer.alloc(32, 42));
  const issuer = createPodTokenIssuer(key);
  const auth = {
    async validateToken(token: string) {
      if (token !== 'A' && token !== 'B') throw new AuthError('Invalid token');
      return { oid: token, name: token, preferred_username: token, roles: [], aud: '', iss: '', exp: 9999999999, iat: 0 };
    },
    validateTokenSync() { throw new AuthError('Unsupported'); },
  };
  authPlugin(app, auth, issuer);
  await inputBundleRoutes(app, store, undefined, (request) => authenticateOperatorRequest(request, auth));
  const contents = [
    Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'),
    Buffer.from('<script>untrusted()</script>'),
  ];
  const upload = store.create({ requestKey: randomUUID(), files: contents.map((bytes, index) => ({
    path: index === 0 ? 'a.png' : 'b.html',
    mediaType: index === 0 ? 'image/png' : 'text/html',
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })) }, 'A');
  for (const [index, bytes] of contents.entries()) store.put(upload.id, 'A', index, bytes);
  const { status: _, ...ref } = store.seal(upload.id, 'A');
  insertConfigurationTestPod(db, 'early-thrush');
  store.pin(ref, 'A', 'early-thrush');
  const config = await resolveLaunch({ repositoryId: 'repo-a', task: 'Use references', work: { inputBundle: ref } }, services, 'A');
  services.readLaunch = () => config;
  configurationRoutes(app, { db, resolution: services, inputBundles: store, capabilities: () => ({}) });
  cleanup.push(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true }); });
  const urls = ['/pods/early-thrush/configuration', `/input-bundles/${ref.id}`, `/input-bundles/${ref.id}/files/0`] as const;
  const headers = { authorization: 'Bearer B' };
  return { db, app, store, services, config, ref, contents, urls, headers, issuer };
}

it('shares sealed configuration, manifest and verified inert originals with authenticated B', async () => {
  const f = await fixture();
  const configuration = await f.app.inject({ url: f.urls[0], headers: f.headers });
  expect(configuration.statusCode).toBe(200);
  expect(configuration.json().work.inputBundle).toEqual(f.ref);
  const manifest = await f.app.inject({ url: f.urls[1], headers: f.headers });
  expect(manifest.statusCode).toBe(200);
  expect(manifest.json()).toEqual({ ...f.ref, status: 'sealed' });
  for (const [index, bytes] of f.contents.entries()) {
    const response = await f.app.inject({ url: `/input-bundles/${f.ref.id}/files/${index}`, headers: f.headers });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(bytes);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe('attachment; filename="reference"');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(response.headers['cache-control']).toBe('private, no-store');
  }
  for (const token of [undefined, 'invalid', f.issuer.generate('early-thrush')]) {
    for (const url of f.urls) {
      expect((await f.app.inject({ url, headers: token ? { authorization: `Bearer ${token}` } : {} })).statusCode).toBe(401);
    }
  }
});

it('retains owner-only writes, rendering, admission and incomplete metadata', async () => {
  const f = await fixture();
  for (const suffix of ['seal', 'render']) {
    expect((await f.app.inject({ method: 'POST', url: `/input-bundles/${f.ref.id}/${suffix}`, headers: f.headers, payload: suffix === 'render' ? { path: 'b.html' } : undefined })).statusCode).toBe(404);
  }
  expect((await f.app.inject({ method: 'PUT', url: f.urls[2], headers: { ...f.headers, 'content-type': 'application/octet-stream' }, payload: f.contents[0] })).statusCode).toBe(404);
  expect(() => f.store.assert(f.ref, 'B')).toThrow('not found');
  await expect(resolveLaunch({ repositoryId: 'repo-a', task: 'Reuse', work: { inputBundle: f.ref } }, f.services, 'B')).rejects.toThrow('not found');
  const incomplete = f.store.create({ requestKey: randomUUID(), files: f.ref.files }, 'A');
  for (const suffix of ['', '/files/0']) {
    expect((await f.app.inject({ url: `/input-bundles/${incomplete.id}${suffix}`, headers: f.headers })).statusCode).toBe(404);
  }
  expect((await f.app.inject({ url: `/input-bundles/${incomplete.id}`, headers: { authorization: 'Bearer A' } })).json().status).toBe('uploading');
  expect((await f.app.inject({ method: 'PUT', url: f.urls[2], headers: { authorization: 'Bearer A', 'content-type': 'application/octet-stream' }, payload: f.contents[0] })).statusCode).toBe(204);
});

it('fails explicitly on frozen manifest mismatch, corrupt manifest and corrupt bytes', async () => {
  const f = await fixture();
  const original = f.config.work.inputBundle!;
  f.config.work.inputBundle = { ...original, digest: 'f'.repeat(64) };
  const mismatch = await f.app.inject({ url: f.urls[0], headers: f.headers });
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.json().error).toBe('INPUT_REFERENCE_MISMATCH');
  f.config.work.inputBundle = original;
  f.db.prepare('UPDATE input_bundle_files SET bytes=? WHERE bundle_id=? AND file_index=0').run(Buffer.from('corrupt'), f.ref.id);
  const corrupt = await f.app.inject({ url: f.urls[2], headers: f.headers });
  expect(corrupt.statusCode).toBe(400);
  expect(corrupt.json().error).toBe('INPUT_BYTES_MISMATCH');
  f.db.prepare('UPDATE input_bundles SET digest=? WHERE id=?').run('e'.repeat(64), f.ref.id);
  for (const url of f.urls) {
    const response = await f.app.inject({ url, headers: f.headers });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('INPUT_BUNDLE_CORRUPT');
  }
});
