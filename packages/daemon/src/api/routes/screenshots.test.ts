import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JwtPayload } from '@autopod/shared';
import { AuthError } from '@autopod/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthModule } from '../../interfaces/index.js';
import { createScreenshotStore } from '../../pods/screenshot-store.js';
import type { ScreenshotStore } from '../../pods/screenshot-store.js';
import { authPlugin } from '../plugins/auth.js';
import { screenshotRoutes } from './screenshots.js';

const testUser: JwtPayload = {
  oid: 'test-user',
  preferred_username: 'tester',
  name: 'Test User',
  roles: ['admin'],
  aud: 'autopod',
  iss: 'autopod-test',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
};

function makeAcceptingAuthModule(): AuthModule {
  return {
    async validateToken() {
      return testUser;
    },
    validateTokenSync() {
      return testUser;
    },
  };
}

function makeRejectingAuthModule(): AuthModule {
  return {
    async validateToken() {
      throw new AuthError('Unauthorized');
    },
    validateTokenSync() {
      throw new AuthError('Unauthorized');
    },
  };
}

// Minimal 4×4 PNG bytes (a real PNG with 4×4 transparent pixels).
// Generated from: Buffer.concat([PNG_HEADER, IHDR_CHUNK, IDAT_CHUNK, IEND_CHUNK])
// For store tests, the content just needs to be a non-empty Buffer.
const SMALL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000040000000408060000009' +
    'bf55898000000174944415478016360f8cfc0c0c0c0c000000000ffff0300' +
    '0f4f47d0000000049454e44ae426082',
  'hex',
);

describe('screenshotRoutes', () => {
  let tmpDir: string;
  let screenshotStore: ScreenshotStore;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'screenshot-route-test-'));
    screenshotStore = createScreenshotStore(tmpDir);
    app = Fastify({ logger: false });
    authPlugin(app, makeAcceptingAuthModule());
    screenshotRoutes(app, screenshotStore);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('200 round-trip', () => {
    it('returns the PNG bytes after a store.write', async () => {
      const podId = 'pod-abc123';
      await screenshotStore.write(podId, 'smoke', 'root.png', SMALL_PNG);

      const res = await app.inject({
        method: 'GET',
        url: `/pods/${podId}/screenshots/smoke/root.png`,
        headers: { authorization: 'Bearer any-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
      expect(Number(res.headers['content-length'])).toBe(SMALL_PNG.length);
      expect(res.rawPayload).toEqual(SMALL_PNG);
    });

    it('serves review source bucket', async () => {
      const podId = 'pod-abc123';
      await screenshotStore.write(podId, 'review', '0.png', SMALL_PNG);

      const res = await app.inject({
        method: 'GET',
        url: `/pods/${podId}/screenshots/review/0.png`,
        headers: { authorization: 'Bearer any-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });
  });

  describe('404 on missing file', () => {
    it('returns 404 when file has not been written', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/missing-pod/screenshots/smoke/nonexistent.png',
        headers: { authorization: 'Bearer any-token' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('400 on bad source', () => {
    it('rejects source not in the allowed set', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/pod-abc/screenshots/badtype/file.png',
        headers: { authorization: 'Bearer any-token' },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toContain('smoke');
      expect(body.error).toContain('fact');
    });
  });

  describe('400 on bad filename', () => {
    it('rejects filenames containing ..', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/pod-abc/screenshots/smoke/..%2Fetc%2Fpasswd',
        headers: { authorization: 'Bearer any-token' },
      });

      // Either 400 or 404 — the URL decode may produce a multi-segment path that
      // Fastify rejects before our handler, but anything except 200 is acceptable.
      expect(res.statusCode).not.toBe(200);
    });

    it('rejects filenames with no .png extension', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/pod-abc/screenshots/smoke/root.jpg',
        headers: { authorization: 'Bearer any-token' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('rejects filenames with special characters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/pods/pod-abc/screenshots/smoke/root%20space.png',
        headers: { authorization: 'Bearer any-token' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('auth', () => {
    it('returns 401 when no Authorization header is present', async () => {
      const savedEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      // Spin up a separate app with a rejecting auth module (simulates production)
      const prodApp = Fastify({ logger: false });
      authPlugin(prodApp, makeRejectingAuthModule());
      screenshotRoutes(prodApp, screenshotStore);
      await prodApp.ready();

      try {
        const res = await prodApp.inject({
          method: 'GET',
          url: '/pods/pod-abc/screenshots/smoke/root.png',
          // No authorization header
        });

        expect([401, 403]).toContain(res.statusCode);
      } finally {
        process.env.NODE_ENV = savedEnv;
        await prodApp.close();
      }
    });

    it('returns 401 when called with an invalid token in production mode', async () => {
      const prodApp = Fastify({ logger: false });
      authPlugin(prodApp, makeRejectingAuthModule());
      screenshotRoutes(prodApp, screenshotStore);
      await prodApp.ready();

      try {
        const res = await prodApp.inject({
          method: 'GET',
          url: '/pods/pod-abc/screenshots/smoke/root.png',
          headers: { authorization: 'Bearer invalid-token' },
        });

        expect([401, 403]).toContain(res.statusCode);
      } finally {
        await prodApp.close();
      }
    });
  });
});
