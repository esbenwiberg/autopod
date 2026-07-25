import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { profileRoutes } from '../api/routes/profiles.js';
import { providerAccountRoutes } from '../api/routes/provider-accounts.js';
import type { CredentialsCipher } from '../crypto/credentials-cipher.js';
import { type ProfileStore, createProfileStore } from '../profiles/index.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createProviderAccountStore } from './provider-account-store.js';
import type { ProviderAccountStore } from './provider-account-store.js';

const rawKey = 'fixture-generic-api-key';

const reversibleCipher: CredentialsCipher = {
  encrypt(value: string): string {
    return `encrypted:${Buffer.from(value, 'utf8').toString('base64')}`;
  },
  decrypt(value: string): string {
    if (!value.startsWith('encrypted:')) throw new Error('not encrypted');
    return Buffer.from(value.slice('encrypted:'.length), 'base64').toString('utf8');
  },
};

function buildApp(profileStore: ProfileStore, providerAccountStore: ProviderAccountStore) {
  const app = Fastify();
  profileRoutes(app, profileStore, async () => {}, undefined, providerAccountStore);
  providerAccountRoutes(app, providerAccountStore, profileStore);
  return app;
}

describe('generic API-key provider accounts', () => {
  let db: ReturnType<typeof createTestDb>;
  let profileStore: ProfileStore;
  let providerAccountStore: ProviderAccountStore;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    db = createTestDb();
    profileStore = createProfileStore(db);
    providerAccountStore = createProviderAccountStore(db, reversibleCipher);
    app = buildApp(profileStore, providerAccountStore);
  });

  it('rejects credential custody until a generic provider is supported and runnable', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/provider-accounts',
      payload: {
        name: 'OpenCode Zen fixture',
        provider: 'opencode-zen',
        credentials: { provider: 'api-key', providerId: 'opencode-zen', apiKey: rawKey },
      },
    });

    expect(created.statusCode).toBe(400);
    expect(created.body).not.toContain(rawKey);
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_accounts').get()).toMatchObject({
      count: 0,
    });
  });

  it('rejects credential identity mismatches and unknown account providers', () => {
    expect(() =>
      providerAccountStore.create({
        name: 'Mismatched generic account',
        provider: 'opencode-zen',
        credentials: { provider: 'api-key', providerId: 'kimi-api', apiKey: rawKey },
      }),
    ).toThrow(/must match/i);

    expect(() =>
      providerAccountStore.create({
        name: 'Unknown generic account',
        provider: 'manifest-fixture-not-present',
        credentials: {
          provider: 'api-key',
          providerId: 'manifest-fixture-not-present',
          apiKey: rawKey,
        },
      }),
    ).toThrow(/compiled provider catalog/i);

    expect(() =>
      providerAccountStore.create({
        name: 'Legacy provider with generic credentials',
        provider: 'anthropic',
        credentials: { provider: 'api-key', providerId: 'anthropic', apiKey: rawKey },
      }),
    ).toThrow(/generic Pi provider/i);
  });
});
