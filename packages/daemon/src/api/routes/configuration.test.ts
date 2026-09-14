import type Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestConfiguration } from '../../test-utils/configuration-helpers.js';
import { createTestDb } from '../../test-utils/mock-helpers.js';
import { errorHandler } from '../error-handler.js';
import { configurationRoutes } from './configuration.js';

describe('composable configuration API', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  beforeEach(async () => {
    db = createTestDb();
    app = Fastify();
    app.setErrorHandler(errorHandler);
    const { services } = createTestConfiguration(db);
    configurationRoutes(app, {
      db,
      resolution: services,
      capabilities: () => ({ schemaVersion: 1, creationEnabled: false }),
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });
  it('previews a repository-first launch without creating a pod', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/launch/resolve',
      payload: { repositoryId: 'repo-b', task: 'Fix' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().repository.id).toBe('repo-b');
    expect(db.prepare('SELECT COUNT(*) AS n FROM pods').get()).toEqual({ n: 0 });
    expect((await app.inject('/configuration/capabilities')).json().creationEnabled).toBe(false);
  });
  it('requires revisions for updates and rejects legacy fields', async () => {
    const current = (await app.inject('/profiles/profile')).json();
    const stale = await app.inject({
      method: 'PUT',
      url: '/profiles/profile',
      payload: { name: 'Renamed', payload: current.payload },
    });
    expect(stale.statusCode).toBe(409);
    const response = await app.inject({
      method: 'PUT',
      url: '/profiles/profile',
      payload: { name: 'Renamed', payload: current.payload, expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().revision).toBe(2);
    const legacy = await app.inject({
      method: 'POST',
      url: '/profiles',
      payload: { name: 'Legacy', payload: { ...current.payload, extends: 'profile' } },
    });
    expect(legacy.statusCode).toBe(400);
  });
  it('saves a changed preset under a new name without editing the shared original', async () => {
    const launch = {
      repositoryId: 'repo-a',
      task: 'Fix',
      overrides: { environment: { template: 'node24' } },
    };
    const missingName = await app.inject({
      method: 'POST',
      url: '/profiles/from-launch',
      payload: { launch, names: { profile: 'New profile' } },
    });
    expect(missingName.statusCode).toBe(400);
    const body = { launch, names: { profile: 'New profile', environment: 'Node 24' } };
    const preview = await app.inject({
      method: 'POST',
      url: '/profiles/from-launch',
      payload: body,
    });
    expect(preview.statusCode).toBe(200);
    expect((await app.inject('/profiles')).json()).toHaveLength(1);
    expect(preview.json().writes.map((w: { kind: string }) => w.kind)).toEqual([
      'environment',
      'profile',
    ]);
    const save = await app.inject({
      method: 'POST',
      url: '/profiles/from-launch',
      payload: { ...body, mode: 'save', expectedDigest: preview.json().digest },
    });
    expect(save.statusCode).toBe(200);
    expect((await app.inject('/presets/environment/env')).json().payload.template).toBe('node22');
    expect(save.json().payload.environmentId).not.toBe('env');
  });
});
