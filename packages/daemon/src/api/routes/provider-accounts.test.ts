import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ProfileStore, createProfileStore } from '../../profiles/index.js';
import { createProviderAccountStore } from '../../provider-accounts/index.js';
import type { ProviderAccountStore } from '../../provider-accounts/index.js';
import { createTestDb } from '../../test-utils/mock-helpers.js';
import { profileRoutes } from './profiles.js';
import { providerAccountRoutes } from './provider-accounts.js';

const validProfile = {
  name: 'app',
  repoUrl: 'https://github.com/org/repo',
  buildCommand: 'npm run build',
  startCommand: 'npm start',
};

function buildApp(profileStore: ProfileStore, providerAccountStore: ProviderAccountStore) {
  const app = Fastify();
  profileRoutes(app, profileStore, async () => {}, undefined, providerAccountStore);
  providerAccountRoutes(app, providerAccountStore, profileStore);
  return app;
}

describe('provider account routes', () => {
  let profileStore: ProfileStore;
  let providerAccountStore: ProviderAccountStore;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    const db = createTestDb();
    profileStore = createProfileStore(db);
    providerAccountStore = createProviderAccountStore(db);
    app = buildApp(profileStore, providerAccountStore);
  });

  it('round-trips ordered failover policy through redacted responses', async () => {
    providerAccountStore.create({
      id: 'claude-max',
      name: 'Claude Max',
      provider: 'max',
      credentials: { provider: 'max', oauthToken: 'target-secret' },
    });
    providerAccountStore.create({
      id: 'copilot',
      name: 'Copilot',
      provider: 'copilot',
      credentials: { provider: 'copilot', token: 'copilot-secret' },
    });
    const targets = [
      { providerAccountId: 'claude-max', runtime: 'claude', model: 'opus' },
      { providerAccountId: 'copilot', runtime: 'copilot', model: 'auto' },
    ];

    const created = await app.inject({
      method: 'POST',
      url: '/provider-accounts',
      payload: {
        id: 'primary',
        name: 'Primary',
        provider: 'openai',
        credentials: { provider: 'openai', authJson: 'source-secret' },
        failoverPolicy: { targets, maxHops: 2 },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().failoverPolicy).toEqual({ targets, maxHops: 2 });
    expect(created.body).not.toContain('source-secret');
    expect(created.body).not.toContain('target-secret');
    expect(created.body).not.toContain('copilot-secret');

    const reversed = [...targets].reverse();
    const updated = await app.inject({
      method: 'PATCH',
      url: '/provider-accounts/primary',
      payload: { failoverPolicy: { targets: reversed, maxHops: 1 } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().failoverPolicy.targets).toEqual(reversed);

    const read = await app.inject({ method: 'GET', url: '/provider-accounts/primary' });
    expect(read.json().failoverPolicy.targets).toEqual(reversed);
  });

  it('rejects invalid failover policies without changing the account', async () => {
    providerAccountStore.create({
      id: 'claude-max',
      name: 'Claude Max',
      provider: 'max',
      credentials: { provider: 'max', oauthToken: 'max-token' },
    });
    providerAccountStore.create({ id: 'primary', name: 'Primary', provider: 'openai' });

    const invalidPolicies = [
      { targets: [{ providerAccountId: 'primary', runtime: 'codex', model: 'gpt-5' }] },
      {
        targets: [
          { providerAccountId: 'claude-max', runtime: 'claude', model: 'opus' },
          { providerAccountId: 'claude-max', runtime: 'claude', model: 'sonnet' },
        ],
      },
      { targets: [{ providerAccountId: 'missing', runtime: 'claude', model: 'opus' }] },
      { targets: [{ providerAccountId: 'claude-max', runtime: 'codex', model: 'gpt-5' }] },
      { targets: [{ providerAccountId: 'claude-max', runtime: 'claude' }] },
      { targets: [] },
    ];

    for (const failoverPolicy of invalidPolicies) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/provider-accounts/primary',
        payload: { failoverPolicy },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(providerAccountStore.get('primary').failoverPolicy).toBeNull();
    }
  });

  it('creates, lists, gets, updates, and redacts provider account credentials', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/provider-accounts',
      payload: {
        name: 'Team OpenAI',
        provider: 'openai',
        credentials: {
          provider: 'openai',
          authMode: 'chatgpt',
          authJson: '{"tokens":{"access_token":"secret"}}',
        },
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toMatchObject({
      id: 'team-openai',
      name: 'Team OpenAI',
      provider: 'openai',
      credentials: { provider: 'openai' },
      hasCredentials: true,
    });
    expect(createResponse.body).not.toContain('access_token');
    expect(createResponse.body).not.toContain('secret');

    const listResponse = await app.inject({ method: 'GET', url: '/provider-accounts' });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toHaveLength(1);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: '/provider-accounts/team-openai',
      payload: { name: 'Shared OpenAI' },
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json().name).toBe('Shared OpenAI');
  });

  it('links and unlinks a profile with mismatch rejection', async () => {
    profileStore.create({
      ...validProfile,
      modelProvider: 'openai',
      defaultRuntime: 'codex',
    });
    providerAccountStore.create({
      name: 'Team OpenAI',
      provider: 'openai',
      credentials: { provider: 'openai', authJson: '{"tokens":{}}' },
    });
    providerAccountStore.create({
      name: 'Team Copilot',
      provider: 'copilot',
      credentials: { provider: 'copilot', token: 'gho_token' },
    });

    const mismatchResponse = await app.inject({
      method: 'POST',
      url: '/provider-accounts/team-copilot/link-profile',
      payload: { profileName: 'app' },
    });
    expect(mismatchResponse.statusCode).toBe(400);

    const linkResponse = await app.inject({
      method: 'POST',
      url: '/provider-accounts/team-openai/link-profile',
      payload: { profileName: 'app' },
    });
    expect(linkResponse.statusCode).toBe(200);
    expect(linkResponse.json().profile.providerAccountId).toBe('team-openai');

    const unlinkResponse = await app.inject({
      method: 'DELETE',
      url: '/profiles/app/provider-account',
    });
    expect(unlinkResponse.statusCode).toBe(204);
    expect(profileStore.getRaw('app').providerAccountId).toBeNull();
  });

  it('clears the profile’s inline credentials on link by default', async () => {
    profileStore.create({
      ...validProfile,
      modelProvider: 'max',
      providerCredentials: {
        provider: 'max',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: '2026-12-31T00:00:00Z',
      },
    });
    providerAccountStore.create({
      id: 'team-max',
      name: 'Team Max',
      provider: 'max',
      credentials: {
        provider: 'max',
        accessToken: 'acc2',
        refreshToken: 'ref2',
        expiresAt: '2026-12-31T00:00:00Z',
      },
    });

    const linkResponse = await app.inject({
      method: 'POST',
      url: '/provider-accounts/team-max/link-profile',
      payload: { profileName: 'app' },
    });
    expect(linkResponse.statusCode).toBe(200);
    expect(profileStore.getRaw('app').providerAccountId).toBe('team-max');
    // Default clears the now-dead inline snapshot.
    expect(profileStore.getRaw('app').providerCredentials).toBeNull();
  });

  it('keeps inline credentials on link when clearLegacyCredentials is false', async () => {
    profileStore.create({
      ...validProfile,
      modelProvider: 'max',
      providerCredentials: {
        provider: 'max',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: '2026-12-31T00:00:00Z',
      },
    });
    providerAccountStore.create({
      id: 'team-max',
      name: 'Team Max',
      provider: 'max',
      credentials: {
        provider: 'max',
        accessToken: 'acc2',
        refreshToken: 'ref2',
        expiresAt: '2026-12-31T00:00:00Z',
      },
    });

    const linkResponse = await app.inject({
      method: 'POST',
      url: '/provider-accounts/team-max/link-profile',
      payload: { profileName: 'app', clearLegacyCredentials: false },
    });
    expect(linkResponse.statusCode).toBe(200);
    expect(profileStore.getRaw('app').providerCredentials?.provider).toBe('max');
  });

  it('imports legacy profile credentials into an account and links selected profiles', async () => {
    profileStore.create({
      ...validProfile,
      name: 'base',
      modelProvider: 'max',
      providerCredentials: {
        provider: 'max',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: '2026-12-31T00:00:00Z',
      },
    });
    profileStore.create({
      ...validProfile,
      name: 'child',
      extends: 'base',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/provider-accounts/import-from-profile',
      payload: {
        profileName: 'child',
        accountName: 'Claude Max Team',
        linkProfileNames: ['base', 'child'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().account).toMatchObject({
      id: 'claude-max-team',
      provider: 'max',
      credentials: { provider: 'max' },
      hasCredentials: true,
    });
    expect(response.body).not.toContain('refresh');
    expect(profileStore.getRaw('base').providerAccountId).toBe('claude-max-team');
    expect(profileStore.getRaw('child').providerAccountId).toBe('claude-max-team');
    // Import clears the owner's inline creds by default — the account is now the
    // source of truth and a leftover stale copy is a latent auth footgun.
    expect(response.json().legacyCredentialsCleared).toBe(true);
    expect(profileStore.getRaw('base').providerCredentials).toBeNull();
  });

  it('preserves legacy credentials on import when clearLegacyCredentials is false', async () => {
    profileStore.create({
      ...validProfile,
      name: 'base',
      modelProvider: 'max',
      providerCredentials: {
        provider: 'max',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: '2026-12-31T00:00:00Z',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/provider-accounts/import-from-profile',
      payload: {
        profileName: 'base',
        accountName: 'Claude Max Team',
        clearLegacyCredentials: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().legacyCredentialsCleared).toBe(false);
    expect(profileStore.getRaw('base').providerCredentials?.provider).toBe('max');
  });

  it('creates a missing stable account id while importing legacy profile credentials', async () => {
    profileStore.create({
      ...validProfile,
      name: 'base',
      modelProvider: 'max',
      providerCredentials: {
        provider: 'max',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: '2026-12-31T00:00:00Z',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/provider-accounts/import-from-profile',
      payload: {
        profileName: 'base',
        accountId: 'anth-pro',
        accountName: 'Anthropic Pro',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().account).toMatchObject({
      id: 'anth-pro',
      name: 'Anthropic Pro',
      provider: 'max',
      credentials: { provider: 'max' },
      hasCredentials: true,
    });
  });

  it('exposes provider account auth source in the profile editor payload', async () => {
    profileStore.create({
      ...validProfile,
      name: 'base',
      modelProvider: 'openai',
      defaultRuntime: 'codex',
    });
    profileStore.create({
      ...validProfile,
      name: 'child',
      extends: 'base',
    });
    providerAccountStore.create({
      name: 'Team OpenAI',
      provider: 'openai',
      credentials: { provider: 'openai', authJson: '{"tokens":{}}' },
    });
    profileStore.update('base', { providerAccountId: 'team-openai' });

    const response = await app.inject({ method: 'GET', url: '/profiles/child/editor' });

    expect(response.statusCode).toBe(200);
    expect(response.json().authSource).toMatchObject({
      type: 'provider-account',
      inherited: true,
      account: {
        id: 'team-openai',
        credentials: { provider: 'openai' },
        hasCredentials: true,
      },
    });
    expect(response.body).not.toContain('tokens');
  });

  it('exposes profile failover replacement semantics and resolved source', async () => {
    providerAccountStore.create({
      id: 'backup-openai',
      name: 'Backup OpenAI',
      provider: 'openai',
    });
    providerAccountStore.create({
      id: 'backup-copilot',
      name: 'Backup Copilot',
      provider: 'copilot',
      credentials: { provider: 'copilot', token: 'secret' },
    });
    providerAccountStore.create({
      id: 'primary',
      name: 'Primary',
      provider: 'openai',
      failoverPolicy: {
        targets: [{ providerAccountId: 'backup-openai', runtime: 'codex', model: 'gpt-5' }],
      },
    });
    profileStore.create({
      ...validProfile,
      name: 'base',
      modelProvider: 'openai',
      providerAccountId: 'primary',
    });
    profileStore.create({ ...validProfile, name: 'child', extends: 'base' });

    const inherited = await app.inject({ method: 'GET', url: '/profiles/child/editor' });
    expect(inherited.json().providerFailoverResolution).toEqual({
      policy: {
        targets: [{ providerAccountId: 'backup-openai', runtime: 'codex', model: 'gpt-5' }],
      },
      source: 'account-default',
    });

    const replacement = {
      targets: [{ providerAccountId: 'backup-copilot', runtime: 'copilot', model: 'auto' }],
    };
    const updated = await app.inject({
      method: 'PATCH',
      url: '/profiles/child',
      payload: { providerFailover: replacement },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().providerFailover).toEqual(replacement);

    const replaced = await app.inject({ method: 'GET', url: '/profiles/child/editor' });
    expect(replaced.json().providerFailoverResolution).toEqual({
      policy: replacement,
      source: 'profile',
    });

    const disabled = await app.inject({
      method: 'PATCH',
      url: '/profiles/child',
      payload: { providerFailover: { targets: [] } },
    });
    expect(disabled.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/profiles/child/editor' })).json()
        .providerFailoverResolution,
    ).toEqual({ policy: { targets: [] }, source: 'profile' });
  });

  it('rejects invalid profile failover targets without changing the profile', async () => {
    providerAccountStore.create({ id: 'primary', name: 'Primary', provider: 'openai' });
    providerAccountStore.create({ id: 'backup', name: 'Backup', provider: 'openai' });
    profileStore.create({
      ...validProfile,
      modelProvider: 'openai',
      providerAccountId: 'primary',
    });

    for (const [providerFailover, expectedStatus] of [
      [{ targets: [{ providerAccountId: 'missing', runtime: 'codex', model: 'gpt-5' }] }, 404],
      [{ targets: [{ providerAccountId: 'missing', runtime: 'codex' }] }, 400],
      ['not-a-policy', 400],
    ] as const) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/profiles/app',
        payload: { providerFailover },
      });
      expect(response.statusCode).toBe(expectedStatus);
      expect(profileStore.getRaw('app').providerFailover).toBeNull();
    }

    profileStore.update('app', {
      providerFailover: {
        targets: [{ providerAccountId: 'backup', runtime: 'codex', model: 'gpt-5' }],
      },
    });
    const selfReferential = await app.inject({
      method: 'PATCH',
      url: '/profiles/app',
      payload: { providerAccountId: 'backup' },
    });
    expect(selfReferential.statusCode).toBeGreaterThanOrEqual(400);
    expect(profileStore.getRaw('app').providerAccountId).toBe('primary');

    const inheritedSelfReference = await app.inject({
      method: 'POST',
      url: '/profiles',
      payload: {
        ...validProfile,
        name: 'child',
        extends: 'app',
        providerFailover: {
          targets: [{ providerAccountId: 'primary', runtime: 'codex', model: 'gpt-5' }],
        },
      },
    });
    expect(inheritedSelfReference.statusCode).toBeGreaterThanOrEqual(400);
    expect(profileStore.exists('child')).toBe(false);

    profileStore.update('app', {
      providerAccountId: 'backup',
      providerFailover: null,
    });
    profileStore.create({
      ...validProfile,
      name: 'policy-parent',
      providerFailover: {
        targets: [{ providerAccountId: 'backup', runtime: 'codex', model: 'gpt-5' }],
      },
    });

    const omittedPolicySelfReference = await app.inject({
      method: 'POST',
      url: '/profiles',
      payload: {
        ...validProfile,
        name: 'inherited-child',
        extends: 'policy-parent',
        providerAccountId: 'backup',
      },
    });
    expect(omittedPolicySelfReference.statusCode).toBe(400);
    expect(profileStore.exists('inherited-child')).toBe(false);

    profileStore.create({ ...validProfile, name: 'reparent-child', providerAccountId: 'backup' });
    const invalidReparent = await app.inject({
      method: 'PATCH',
      url: '/profiles/reparent-child',
      payload: { extends: 'policy-parent' },
    });
    expect(invalidReparent.statusCode).toBe(400);
    expect(profileStore.getRaw('reparent-child').extends).toBeNull();

    profileStore.create({ ...validProfile, name: 'family-root' });
    profileStore.create({
      ...validProfile,
      name: 'family-child',
      extends: 'family-root',
      providerAccountId: 'backup',
    });
    const invalidParentUpdate = await app.inject({
      method: 'PATCH',
      url: '/profiles/family-root',
      payload: {
        providerFailover: {
          targets: [{ providerAccountId: 'backup', runtime: 'codex', model: 'gpt-5' }],
        },
      },
    });
    expect(invalidParentUpdate.statusCode).toBe(400);
    expect(profileStore.getRaw('family-root').providerFailover).toBeNull();
  });
});
