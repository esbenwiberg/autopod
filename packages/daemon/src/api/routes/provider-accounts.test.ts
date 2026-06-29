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
});
