import fs from 'node:fs';
import path from 'node:path';
import {
  type CompiledProviderManifest,
  PROVIDER_CATALOG,
  type Profile,
  type Runtime,
  createProviderCatalog,
} from '@autopod/shared';
import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { modelProviderRoutes } from './api/routes/model-providers.js';
import { profileRoutes } from './api/routes/profiles.js';
import { providerAccountRoutes } from './api/routes/provider-accounts.js';
import type { CredentialsCipher } from './crypto/credentials-cipher.js';
import { type NetworkManager, createPodManager } from './pods/pod-manager.js';
import { resolveProviderPreflight } from './pods/provider-preflight.js';
import { addRuntimeNetworkDefaults } from './pods/runtime-network-defaults.js';
import { createProfileStore } from './profiles/index.js';
import { createProviderAccountStore } from './provider-accounts/index.js';
import { buildProviderEnv } from './providers/index.js';
import {
  createTestContext as createPodManagerTestContext,
  createTestDb,
} from './test-utils/mock-helpers.js';

const fixtureProviderId = 'fixture-cloud';
const fixturePiProviderId = 'fixture-wire';
const fixtureModelId = 'fixture-wire/reviewed-model';
const fixtureHost = 'api.fixture.example';
const sentinelKey = 'sentinel-provider-key-must-not-leak';

function fixtureManifest(): CompiledProviderManifest {
  return {
    manifestVersion: 1,
    piCompatibility: { ...PROVIDER_CATALOG.piCompatibility },
    providers: [
      {
        id: fixtureProviderId,
        displayName: 'Fixture Cloud',
        description: 'Manifest-only provider used for deterministic conformance.',
        icon: 'unknown-fixture-icon',
        implementation: { kind: 'generic-pi-api', piProviderId: fixturePiProviderId },
        credentialOptions: [
          {
            kind: 'api-key',
            label: 'Fixture API key',
            acquisition: 'Use the deterministic test sentinel.',
          },
        ],
        modelIds: [fixtureModelId],
        requiredHosts: [fixtureHost],
        policy: {
          lifecycle: 'active',
          authorization: 'supported',
          runnable: true,
          caveats: [
            { kind: 'privacy', severity: 'warning', message: 'Synthetic fixture data only.' },
          ],
        },
      },
    ],
    models: [
      {
        id: fixtureModelId,
        providerId: fixtureProviderId,
        displayName: 'Reviewed Fixture Model',
        lifecycle: 'active',
      },
    ],
  };
}

const reversibleTestCipher: CredentialsCipher = {
  encrypt: (value) => `ciphertext:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (value) => Buffer.from(value.slice('ciphertext:'.length), 'base64').toString('utf8'),
};

function createHarness() {
  const catalog = createProviderCatalog(fixtureManifest());
  const db = createTestDb();
  const profileStore = createProfileStore(db, reversibleTestCipher);
  const providerAccountStore = createProviderAccountStore(db, reversibleTestCipher, catalog);
  const app = Fastify();
  modelProviderRoutes(app, catalog);
  profileRoutes(app, profileStore, async () => {}, undefined, providerAccountStore);
  providerAccountRoutes(app, providerAccountStore, profileStore, catalog);
  return { app, catalog, db, profileStore, providerAccountStore };
}

async function createLinkedFixture() {
  const harness = createHarness();
  const accountResponse = await harness.app.inject({
    method: 'POST',
    url: '/provider-accounts',
    payload: {
      id: 'fixture-account',
      name: 'Fixture Account',
      provider: fixtureProviderId,
      credentials: {
        provider: 'api-key',
        providerId: fixtureProviderId,
        apiKey: sentinelKey,
      },
    },
  });
  expect(accountResponse.statusCode).toBe(201);

  harness.profileStore.create({
    name: 'fixture-profile',
    repoUrl: 'https://github.com/example/repository',
    buildCommand: 'npx pnpm build',
    startCommand: 'npx pnpm start',
    defaultRuntime: 'pi',
    defaultModel: fixtureModelId,
    reviewerModel: fixtureModelId,
    modelProvider: 'pi',
    networkPolicy: {
      enabled: true,
      mode: 'restricted',
      allowedHosts: ['github.com'],
    },
  });
  const linkResponse = await harness.app.inject({
    method: 'POST',
    url: '/provider-accounts/fixture-account/link-profile',
    payload: { profileName: 'fixture-profile' },
  });
  expect(linkResponse.statusCode).toBe(200);

  return { ...harness, accountResponse, linkResponse };
}

describe('provider portability integration', () => {
  it('onboards a manifest-only provider', async () => {
    const { app, catalog, profileStore, providerAccountStore } = await createLinkedFixture();
    const catalogResponse = await app.inject({ method: 'GET', url: '/model-providers' });
    expect(catalogResponse.statusCode).toBe(200);
    expect(catalogResponse.json()).toMatchObject({
      providers: [
        {
          id: fixtureProviderId,
          implementation: { kind: 'generic-pi-api', piProviderId: fixturePiProviderId },
          modelIds: [fixtureModelId],
        },
      ],
      models: [{ id: fixtureModelId, providerId: fixtureProviderId }],
    });

    const profile = profileStore.get('fixture-profile');
    const tuple = resolveProviderPreflight(profile, undefined, undefined, {
      profileStore,
      providerAccountStore,
      manifest: catalog,
    });
    expect(tuple).toMatchObject({
      runtime: 'pi',
      model: fixtureModelId,
      account: { provider: fixtureProviderId },
      manifestProvider: { id: fixtureProviderId },
    });

    const resolvedNetwork = addRuntimeNetworkDefaults(
      profile.networkPolicy,
      profile,
      tuple.runtime,
      tuple.manifestProvider,
    );
    expect(resolvedNetwork?.allowedHosts).toEqual(['github.com', fixtureHost]);
    expect(resolvedNetwork?.allowedHosts).not.toContain('chatgpt.com');

    const providerEnv = await buildProviderEnv(profile, 'fixture-pod', pino({ level: 'silent' }), {
      runtime: tuple.runtime,
      providerAccountStore,
      providerCatalog: catalog,
    });
    expect(providerEnv.secretFiles.map(({ path: filePath }) => filePath)).toEqual([
      '/run/autopod/model-provider-key',
    ]);
    const authFile = providerEnv.containerFiles.find(({ path: filePath }) =>
      filePath.endsWith('/.pi/agent/auth.json'),
    );
    expect(JSON.parse(authFile?.content ?? '{}')).toEqual({
      [fixturePiProviderId]: {
        type: 'api_key',
        key: '!cat /run/autopod/model-provider-key',
      },
    });
    expect(providerEnv.requiresPostExecPersistence).toBe(false);
    expect(providerEnv.requiresPiAuthJsonPersistence).toBe(false);

    const runtimeSpawn = vi.fn<Runtime['spawn']>(async function* () {});
    const managerContext = createPodManagerTestContext({
      runtime: {
        type: 'pi',
        spawn: runtimeSpawn,
        resume: vi.fn(async function* () {}),
        abort: vi.fn(async () => {}),
        suspend: vi.fn(async () => {}),
      },
    });
    managerContext.profileStore.get = vi.fn(() => ({
      ...profile,
      name: 'test-profile',
    }));
    managerContext.profileStore.resolveProviderAccountId = vi.fn(() => 'fixture-account');
    const managerLogs: string[] = [];
    managerContext.deps.logger = pino(
      { level: 'trace' },
      { write: (message) => managerLogs.push(message) },
    );
    const buildNetworkConfig = vi.fn<NetworkManager['buildNetworkConfig']>(async () => ({
      networkName: 'autopod-fixture',
      firewallScript: 'fixture-firewall',
    }));
    managerContext.deps.providerAccountStore = providerAccountStore;
    managerContext.deps.providerCatalog = catalog;
    managerContext.deps.networkManager = {
      buildNetworkConfig,
      getGatewayIp: vi.fn(async () => '172.18.0.1'),
    };
    const manager = createPodManager(managerContext.deps);
    const pod = manager.createSession(
      {
        profileName: 'test-profile',
        task: 'Exercise manifest-only provider orchestration',
        skipValidation: true,
      },
      'fixture-user',
    );
    await manager.processPod(pod.id);

    expect(manager.getSession(pod.id)).toMatchObject({
      status: 'validated',
      runtime: 'pi',
      model: fixtureModelId,
      providerIdSnapshot: fixtureProviderId,
      providerAccountIdSnapshot: 'fixture-account',
    });
    expect(buildNetworkConfig).toHaveBeenCalledWith(
      expect.objectContaining({ allowedHosts: ['github.com', fixtureHost] }),
      expect.any(Array),
      '172.18.0.1',
      expect.any(Array),
      pod.id,
      [],
      ['localhost'],
      8080,
    );
    expect(managerContext.containerManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        networkName: 'autopod-fixture',
        firewallScript: 'fixture-firewall',
      }),
    );
    expect(managerContext.containerManager.writeFile).toHaveBeenCalledWith(
      'container-123',
      '/run/autopod/model-provider-key',
      sentinelKey,
    );
    expect(managerContext.containerManager.writeFile).toHaveBeenCalledWith(
      'container-123',
      '/home/autopod/.pi/agent/auth.json',
      expect.stringContaining('!cat /run/autopod/model-provider-key'),
    );
    const spawnConfig = runtimeSpawn.mock.calls[0]?.[0];
    expect(spawnConfig).toMatchObject({ model: fixtureModelId });
    expect(JSON.stringify(spawnConfig)).not.toContain(sentinelKey);
    expect(
      JSON.stringify(vi.mocked(managerContext.containerManager.spawn).mock.calls),
    ).not.toContain(sentinelKey);
    expect(
      JSON.stringify(vi.mocked(managerContext.containerManager.execInContainer).mock.calls),
    ).not.toContain(sentinelKey);
    expect(JSON.stringify(managerLogs)).not.toContain(sentinelKey);
    const ordinaryWrites = vi
      .mocked(managerContext.containerManager.writeFile)
      .mock.calls.filter(([, filePath]) => filePath !== '/run/autopod/model-provider-key');
    expect(JSON.stringify(ordinaryWrites)).not.toContain(sentinelKey);

    await app.close();
  });

  it('keeps the sentinel key secret-file only', async () => {
    const { app, accountResponse, linkResponse, db, profileStore, providerAccountStore, catalog } =
      await createLinkedFixture();
    const rawRow = db
      .prepare('SELECT credentials FROM provider_accounts WHERE id = ?')
      .get('fixture-account') as { credentials: string };
    expect(rawRow.credentials).toMatch(/^ciphertext:/);
    expect(rawRow.credentials).not.toContain(sentinelKey);

    const logs: string[] = [];
    const logger = pino({ level: 'trace' }, { write: (message) => logs.push(message) });
    const result = await buildProviderEnv(
      profileStore.get('fixture-profile'),
      'fixture-pod',
      logger,
      {
        runtime: 'pi',
        providerAccountStore,
        providerCatalog: catalog,
      },
    );
    expect(result.secretFiles).toEqual([
      { path: '/run/autopod/model-provider-key', content: sentinelKey },
    ]);

    const ordinarySpawnSurfaces = {
      accountApi: accountResponse.body,
      profileLinkApi: linkResponse.body,
      containerFiles: result.containerFiles,
      environment: result.env,
      logs,
      persistence: {
        requiresPostExecPersistence: result.requiresPostExecPersistence,
        requiresPiAuthJsonPersistence: result.requiresPiAuthJsonPersistence,
      },
    };
    expect(JSON.stringify(ordinarySpawnSurfaces)).not.toContain(sentinelKey);
    expect(accountResponse.json()).toMatchObject({
      credentials: { provider: 'api-key', providerId: fixtureProviderId },
      hasCredentials: true,
    });

    await app.close();
  });

  it('blocks unauthorized initial providers', () => {
    const credentialRead = vi.fn();
    const accountGet = vi.fn((id: string) => {
      const account = {
        id,
        name: id,
        provider: id.replace(/-account$/, ''),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastAuthenticatedAt: null,
        lastUsedAt: null,
      };
      return Object.defineProperty(account, 'credentials', {
        get: () => {
          credentialRead();
          throw new Error('policy gate read credentials');
        },
      });
    });
    const providerAccountStore = { get: accountGet } as never;

    for (const [providerId, model, code] of [
      ['opencode-zen', 'opencode/claude-sonnet-4-5', 'PROVIDER_AUTHORIZATION_PENDING'],
      ['opencode-go', 'opencode-go/kimi-k2.5', 'PROVIDER_AUTHORIZATION_PENDING'],
      ['kimi-code', 'kimi-coding/k2p5', 'PROVIDER_BLOCKED'],
      ['kimi-api', 'moonshotai/kimi-k2.5', 'PROVIDER_AUTHORIZATION_PENDING'],
    ] as const) {
      const profile = {
        name: `${providerId}-profile`,
        defaultRuntime: 'pi',
        defaultModel: model,
        modelProvider: 'pi',
        providerAccountId: `${providerId}-account`,
      } as Profile;
      expect(() =>
        resolveProviderPreflight(profile, undefined, undefined, {
          providerAccountStore,
        }),
      ).toThrow(expect.objectContaining({ code }));
    }
    expect(accountGet).toHaveBeenCalledTimes(4);
    expect(credentialRead).not.toHaveBeenCalled();
  });

  it('keeps the fixture out of runtime and product source inventories', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    const fixtureIdentifiers = [
      fixtureProviderId,
      fixturePiProviderId,
      fixtureModelId,
      fixtureHost,
      'unknown-fixture-icon',
      sentinelKey,
    ];
    const runtimeTypeSource = fs.readFileSync(
      path.join(root, 'packages/shared/src/types/runtime.ts'),
      'utf8',
    );
    expect(runtimeTypeSource).toContain(
      "export type RuntimeType = 'claude' | 'codex' | 'copilot' | 'pi';",
    );

    for (const relativeDirectory of [
      'packages/shared/src',
      'packages/daemon/src',
      'packages/cli/src',
      'packages/desktop/Sources',
    ]) {
      const directory = path.join(root, relativeDirectory);
      const files = fs
        .readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            /\.(ts|swift)$/.test(entry.name) &&
            !/\.(test|spec)\.ts$/.test(entry.name),
        );
      for (const file of files) {
        const filePath = path.join(file.parentPath, file.name);
        const source = fs.readFileSync(filePath, 'utf8');
        for (const identifier of fixtureIdentifiers) {
          expect(
            source,
            `${identifier} must remain fixture data; found in ${filePath}`,
          ).not.toContain(identifier);
        }
      }
    }
  });
});
