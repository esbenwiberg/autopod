import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { terminationAuth } from '../../test-utils/termination-reconciliation-helpers.js';
import { errorHandler } from '../error-handler.js';
import { authPlugin } from '../plugins/auth.js';
import { fileRecoveryRoutes } from './file-recovery.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
function fixture() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler(errorHandler);
  authPlugin(app, terminationAuth());
  const getRecoveryFiles = vi.fn(async (id: string) => ({
    version: 1 as const,
    podId: id,
    generation: 3,
    sources: [],
    limits: {
      maxFileBytes: 5242880,
      maxSelectionBytes: 52428800,
      maxFiles: 2000,
      maxVisited: 10000,
      maxDepth: 16,
    },
    excludes: [],
  }));
  const readRecoveryFile = vi.fn(async (_id: string, selection: { path: string }) => ({
    path: selection.path,
    encoding: 'base64' as const,
    content: 'AA==',
    size: 1,
    sha256: 'a'.repeat(64),
  }));
  fileRecoveryRoutes(app, { getRecoveryFiles, readRecoveryFile });
  return { app, getRecoveryFiles, readRecoveryFile };
}
const headers = { authorization: 'Bearer human-token' };
const query = {
  sourceId: 'saved-workspace',
  binding: 'b'.repeat(64),
  generation: '3',
  path: 'src/a b.ts',
  version: 'a'.repeat(64),
};
it('requires human identity for both list and byte reads', async () => {
  const f = fixture();
  for (const auth of [{}, { authorization: 'Bearer pod-token' }])
    for (const path of ['', `/content?${new URLSearchParams(query)}`]) {
      const response = await f.app.inject({ url: `/pods/p/file-recovery${path}`, headers: auth });
      expect(response.statusCode).toBe(401);
    }
  expect(f.getRecoveryFiles).not.toHaveBeenCalled();
  expect(f.readRecoveryFile).not.toHaveBeenCalled();
});
it('uses read-only routes, explicit source/version/generation and no-store responses', async () => {
  const f = fixture();
  const list = await f.app.inject({ url: '/pods/p/file-recovery', headers });
  expect(list.statusCode).toBe(200);
  expect(list.headers['cache-control']).toBe('no-store');
  const read = await f.app.inject({
    url: `/pods/p/file-recovery/content?${new URLSearchParams(query)}`,
    headers,
  });
  expect(read.statusCode).toBe(200);
  expect(read.headers['cache-control']).toBe('no-store');
  expect(f.readRecoveryFile).toHaveBeenCalledWith('p', { ...query, generation: 3 });
});
it('rejects traversal, arbitrary sources, missing bindings, extra override fields and invalid generations', async () => {
  const f = fixture();
  for (const change of [
    { path: '../secret' },
    { path: '/etc/passwd' },
    { path: '.env' },
    { sourceId: 'any-host-path' },
    { binding: '' },
    { version: '' },
    { generation: 'bad' },
    { generation: '-1' },
    { force: 'true' },
  ]) {
    const response = await f.app.inject({
      url: `/pods/p/file-recovery/content?${new URLSearchParams({ ...query, ...change })}`,
      headers,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(f.readRecoveryFile).not.toHaveBeenCalled();
});
