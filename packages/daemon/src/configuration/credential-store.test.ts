import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../crypto/credentials-cipher.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { resolveLaunchCredentialReferences, resolveLaunchValues } from './credential-references.js';
import { createConfigurationCredentialStore } from './credential-store.js';
import { createLaunchExecutionCredentials } from './execution-credentials.js';
import { resolveLaunchExecutionSettings } from './launch-execution-settings.js';
import { resolveLaunch } from './launch-resolver.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'autopod-credential-fixture-'));
  const db = createTestDb();
  const verify = vi.fn(async () => {});
  const credentials = createConfigurationCredentialStore(
    db,
    loadOrCreateKey(join(dir, 'fixture.key')),
    verify,
  );
  return {
    db,
    credentials,
    verify,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
describe('configuration credential references', () => {
  it('stores encrypted values, returns metadata only, and resolves current rotation under pinned identity', async () => {
    const f = fixture();
    try {
      const first = await f.credentials.create({
        id: 'service',
        name: 'Service',
        purposes: ['build-env'],
        origins: [],
        value: 'first-fixture-value',
      });
      expect(JSON.stringify(first)).not.toContain('first-fixture-value');
      const stored = f.db
        .prepare('SELECT encrypted_value FROM configuration_credentials')
        .get() as { encrypted_value: string };
      expect(stored.encrypted_value).not.toContain('first-fixture-value');
      expect(await f.credentials.resolve(first.id, first.createdAt, 'build-env')).toBe(
        'first-fixture-value',
      );
      const rotated = await f.credentials.rotate(first.id, first.revision, 'rotated-fixture-value');
      expect(rotated.createdAt).toBe(first.createdAt);
      expect(await f.credentials.resolve(first.id, first.createdAt, 'build-env')).toBe(
        'rotated-fixture-value',
      );
      f.credentials.revoke(first.id, rotated.revision);
      await expect(f.credentials.resolve(first.id, first.createdAt, 'build-env')).rejects.toThrow(
        'revoked',
      );
      await expect(
        f.credentials.rotate(first.id, rotated.revision + 1, 'another-fixture'),
      ).rejects.toThrow('Revoked');
    } finally {
      f.close();
    }
  });
  it('keeps launch snapshots secret-free and rejects a credential used for another destination', async () => {
    const f = fixture();
    try {
      await f.credentials.create({
        id: 'service',
        name: 'Service',
        purposes: ['build-env'],
        origins: [],
        value: 'private-fixture-value',
      });
      const { store, services } = createTestConfiguration(f.db);
      services.resolveCredentialReferences = async (config) =>
        resolveLaunchCredentialReferences(config, f.credentials);
      const config = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Debug',
          overrides: { repositorySetup: { buildEnv: { SERVICE_KEY: { secretId: 'service' } } } },
        },
        services,
      );
      expect(JSON.stringify(config)).not.toContain('private-fixture-value');
      expect(config.credentialReferences.service).toMatchObject({ secretId: 'service' });
      const env = await resolveLaunchValues(
        config,
        config.repository?.setup.buildEnv ?? {},
        'build-env',
        f.credentials,
      );
      expect(env).toEqual({ SERVICE_KEY: 'private-fixture-value' });
      await expect(
        resolveLaunchValues(
          config,
          { Authorization: { secretId: 'service' } },
          'mcp-http',
          f.credentials,
          'https://example.com',
        ),
      ).rejects.toThrow('scope');
      expect(store.list('repository')).toHaveLength(2);
    } finally {
      f.close();
    }
  });
  it('materializes each execution purpose separately without changing the saved snapshot', async () => {
    const f = fixture();
    try {
      for (const [id, purpose, origins] of [
        ['build', 'build-env', []],
        ['stdio', 'mcp-env', []],
        ['http', 'mcp-http', ['https://mcp.example.com']],
        ['deploy', 'deployment-env', []],
        ['feed-a', 'registry-read', ['https://packages.example.com']],
        ['feed-b', 'registry-read', ['https://nuget.example.com']],
      ] as const)
        await f.credentials.create({
          id,
          name: id,
          purposes: [purpose],
          origins: [...origins],
          value: `private-${id}-fixture`,
        });
      const { services, store } = createTestConfiguration(f.db);
      services.resolveCredentialReferences = async (config) =>
        resolveLaunchCredentialReferences(config, f.credentials);
      const repo = store.get('repository', 'repo-a');
      const setup = repo.payload.setups[0]!;
      store.write({
        ...repo,
        expectedRevision: repo.revision,
        payload: {
          ...repo.payload,
          setups: [
            {
              ...setup,
              buildEnv: { SERVICE_KEY: { secretId: 'build' } },
              integrations: {
                ...setup.integrations,
                deployment: {
                  enabled: false,
                  env: { DEPLOY_KEY: { secretId: 'deploy' } },
                  allowedScripts: ['deploy.sh'],
                },
                privateRegistries: [
                  {
                    type: 'npm',
                    scope: '@example',
                    url: 'https://packages.example.com/feed/',
                    credential: { secretId: 'feed-a' },
                  },
                  {
                    type: 'nuget',
                    url: 'https://nuget.example.com/feed/',
                    credential: { secretId: 'feed-b' },
                  },
                ],
              },
            },
          ],
        },
      });
      const config = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Debug',
          overrides: {
            toolPacks: [
              {
                mcpServers: [
                  {
                    name: 'local',
                    transport: {
                      type: 'stdio',
                      command: 'fixture-service',
                      args: [],
                      env: { SERVICE_KEY: { secretId: 'stdio' } },
                    },
                  },
                  {
                    name: 'remote',
                    transport: {
                      type: 'http',
                      url: 'https://mcp.example.com',
                      headers: { Authorization: { secretId: 'http' } },
                    },
                  },
                ],
              },
            ],
          },
        },
        services,
      );
      const frozen = JSON.stringify(config);
      expect(
        JSON.stringify(resolveLaunchExecutionSettings(config, { image: 'fixture-image' })),
      ).not.toContain('private-');
      const execution = createLaunchExecutionCredentials(f.credentials);
      const agent = await execution.agent(config);
      expect(agent.buildEnv).toEqual({ SERVICE_KEY: 'private-build-fixture' });
      expect(JSON.stringify(agent)).toContain('private-stdio-fixture');
      expect(JSON.stringify(agent)).not.toContain('private-http-fixture');
      expect(JSON.stringify(agent)).not.toContain('private-deploy-fixture');
      expect(await execution.httpServer(config, 'remote')).toMatchObject({
        headers: { Authorization: 'private-http-fixture' },
      });
      const registries = await execution.registries(config);
      expect(registries.files.find((file) => file.path.endsWith('.npmrc'))?.content).toContain(
        'private-feed-a-fixture',
      );
      expect(registries.nugetSecret?.content).toContain('private-feed-b-fixture');
      expect(registries.nugetSecret?.content).not.toContain('private-feed-a-fixture');
      expect(await execution.deployment(config)).toMatchObject({
        env: { DEPLOY_KEY: 'private-deploy-fixture' },
      });
      expect(JSON.stringify(config)).toBe(frozen);
      f.credentials.revoke('http', 1);
      await expect(execution.httpServer(config, 'remote')).rejects.toThrow('revoked');
      expect(await execution.agent(config)).toEqual(agent);
    } finally {
      f.close();
    }
  });
  it('refuses direct source credentials and records no secret before verification', async () => {
    const f = fixture();
    try {
      await expect(
        f.credentials.create({
          name: 'Forbidden',
          purposes: ['mcp-env'],
          origins: [],
          value: `ghp_${'x'.repeat(36)}`,
        }),
      ).rejects.toThrow('cannot be injected');
      expect(f.credentials.list()).toEqual([]);
      f.verify.mockRejectedValueOnce(new Error('Unverified service scope'));
      await expect(
        f.credentials.create({
          name: 'Unverified',
          purposes: ['registry-read'],
          origins: ['https://packages.example.com'],
          value: 'unverified-fixture',
        }),
      ).rejects.toThrow('Unverified');
      expect(f.credentials.list()).toEqual([]);
    } finally {
      f.close();
    }
  });
});
