import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfigurationCredentialStore } from '../../configuration/credential-store.js';
import { probePackageFeed } from '../../configuration/package-feed-probe.js';
import { loadOrCreateKey } from '../../crypto/credentials-cipher.js';
import { createTestConfiguration } from '../../test-utils/configuration-helpers.js';
import { createTestDb } from '../../test-utils/mock-helpers.js';
import { errorHandler } from '../error-handler.js';
import { configurationRoutes } from './configuration.js';

vi.mock('../../configuration/package-feed-probe.js', () => ({ probePackageFeed: vi.fn() }));

describe('operator package feed API', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'feed-api-'));
    const db = createTestDb();
    const { services, store } = createTestConfiguration(db);
    const credentials = createConfigurationCredentialStore(
      db,
      loadOrCreateKey(join(dir, 'key')),
      async () => {},
    );
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    configurationRoutes(app, { db, resolution: services, credentials, capabilities: () => ({}) });
    await app.ready();
    return { dir, db, app, credentials, store };
  }
  beforeEach(async () => {
    vi.mocked(probePackageFeed)
      .mockReset()
      .mockResolvedValue({ status: 'authenticated', message: 'Authenticated read succeeded.' });
    f = await fixture();
  });
  afterEach(async () => {
    await f.app.close();
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  });
  async function enroll() {
    const response = await f.app.inject({
      method: 'POST',
      url: '/configuration/credentials',
      payload: {
        id: 'registry',
        name: 'Packages',
        purposes: ['registry-read'],
        origins: ['https://packages.example.com'],
        value: 'fixture-private-value',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain('fixture-private-value');
    const feed = await f.app.inject({
      method: 'POST',
      url: '/presets/packageFeed',
      payload: {
        id: 'feed',
        name: 'Packages',
        payload: {
          type: 'npm',
          url: 'https://packages.example.com/',
          credential: { secretId: 'registry' },
        },
      },
    });
    expect(feed.statusCode).toBe(201);
  }
  it('supports secure shared credential rotation and revision-bound connection tests', async () => {
    await enroll();
    const test = () =>
      f.app.inject({
        method: 'POST',
        url: '/configuration/package-feeds/feed/test',
        payload: { expectedRevision: 1 },
      });
    expect((await test()).json().status).toBe('authenticated');
    expect(probePackageFeed).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'npm' }),
      'fixture-private-value',
    );
    const rotated = await f.app.inject({
      method: 'PUT',
      url: '/configuration/credentials/registry',
      payload: { expectedRevision: 1, value: 'fixture-replacement' },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toContain('fixture-replacement');
    expect((await test()).statusCode).toBe(200);
    expect(probePackageFeed).toHaveBeenLastCalledWith(expect.anything(), 'fixture-replacement');
    expect((await f.app.inject('/presets/packageFeed')).body).not.toContain('fixture-replacement');
    const stale = await f.app.inject({
      method: 'POST',
      url: '/configuration/package-feeds/feed/test',
      payload: { expectedRevision: 2 },
    });
    expect(stale.statusCode).toBe(409);
  });
  it('refuses credential changes during a probe rather than returning stale success', async () => {
    await enroll();
    vi.mocked(probePackageFeed).mockImplementationOnce(async () => {
      f.credentials.revoke('registry', 1);
      return { status: 'authenticated', message: 'Should not be returned' };
    });
    const response = await f.app.inject({
      method: 'POST',
      url: '/configuration/package-feeds/feed/test',
      payload: { expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('Should not be returned');
    expect(response.body).not.toContain('fixture-private-value');
  });
});
