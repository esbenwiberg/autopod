import { describe, expect, it } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { launchSidecarSpec } from './launch-sidecars.js';

describe('launch sidecars', () => {
  it('uses admitted allocation, application readiness and ephemeral connection credentials', async () => {
    const db = createTestDb();
    try {
      const { services } = createTestConfiguration(db);
      const config = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Test',
          overrides: {
            environment: {
              sidecars: [
                {
                  id: 'db',
                  type: 'postgres',
                  image: `postgres@sha256:${'a'.repeat(64)}`,
                  version: '17',
                  port: 5432,
                  startup: 'always',
                },
                {
                  id: 'cache',
                  type: 'redis',
                  image: `redis@sha256:${'b'.repeat(64)}`,
                  version: '7',
                  port: 6379,
                  startup: 'always',
                },
              ],
            },
          },
        },
        services,
      );
      const password = 'ephemeral-fixture-credential-1234';
      const original = JSON.stringify(config);
      const postgres = launchSidecarSpec(config, 'db', password);
      expect(postgres.spec.privileged).not.toBe(true);
      expect(postgres.spec.resources.memoryMb).toBe(1024);
      expect(postgres.spec.env?.POSTGRES_PASSWORD).toBe(password);
      expect(postgres.spec.healthCheck.command?.[0]).toBe('pg_isready');
      expect(postgres.podEnv.AUTOPOD_SIDECAR_DB_URL).toContain('@db:5432/autopod');
      const redis = launchSidecarSpec(config, 'cache', password);
      expect(redis.spec.healthCheck.command?.join(' ')).toContain('= PONG');
      expect(redis.spec.command?.join(' ')).not.toContain(password);
      expect(redis.podEnv.AUTOPOD_SIDECAR_CACHE_URL).toContain('@cache:6379');
      expect(JSON.stringify(config)).toBe(original);
      expect(JSON.stringify(config)).not.toContain(password);
      expect(() => launchSidecarSpec(config, 'missing', password)).toThrow('admitted');
      expect(() => launchSidecarSpec(config, 'db')).toThrow('credential');
    } finally {
      db.close();
    }
  });
});
