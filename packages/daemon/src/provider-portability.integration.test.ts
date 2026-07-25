import fs from 'node:fs';
import path from 'node:path';
import {
  type CompiledProviderManifest,
  PROVIDER_CATALOG,
  type Profile,
  createProviderCatalog,
} from '@autopod/shared';
import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { modelProviderRoutes } from './api/routes/model-providers.js';
import { profileRoutes } from './api/routes/profiles.js';
import { providerAccountRoutes } from './api/routes/provider-accounts.js';
import type { CredentialsCipher } from './crypto/credentials-cipher.js';
import { resolveProviderPreflight } from './pods/provider-preflight.js';
import { addRuntimeNetworkDefaults } from './pods/runtime-network-defaults.js';
import { createProfileStore } from './profiles/index.js';
import { createProviderAccountStore } from './provider-accounts/index.js';
import { buildProviderEnv } from './providers/index.js';
import { createTestDb } from './test-utils/mock-helpers.js';

const fixtureProviderId = 'fixture-cloud';
const fixturePiProviderId = 'fixture';
const fixtureModelId = 'fixture/reviewed-model';
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
      arguments: ['pi', '--model', fixtureModelId],
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
    const runtimeTypeSource = fs.readFileSync(
      path.join(root, 'packages/shared/src/types/runtime.ts'),
      'utf8',
    );
    expect(runtimeTypeSource).toContain(
      "export type RuntimeType = 'claude' | 'codex' | 'copilot' | 'pi';",
    );
    expect(runtimeTypeSource).not.toContain(fixtureProviderId);

    for (const relativeDirectory of [
      'packages/daemon/src/runtimes',
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
        expect(fs.readFileSync(filePath, 'utf8'), filePath).not.toContain(fixtureProviderId);
      }
    }
  });
});
