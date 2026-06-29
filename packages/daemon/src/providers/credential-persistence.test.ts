import type { MaxCredentials, Profile, ProviderCredentials } from '@autopod/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import {
  persistOpenAiAuthJson,
  persistRefreshedCredentials,
  refreshAndPersistMaxCredentials,
} from './credential-persistence.js';

const logger = pino({ level: 'silent' });

function makeContainerManager(fileContent: string): ContainerManager {
  return {
    readFile: vi.fn().mockResolvedValue(fileContent),
    spawn: vi.fn(),
    kill: vi.fn(),
    writeFile: vi.fn(),
    getStatus: vi.fn(),
    execInContainer: vi.fn(),
    execStreaming: vi.fn(),
  } as unknown as ContainerManager;
}

function makeProfileStore(
  currentCreds: MaxCredentials | null,
  opts: { ownerName?: string } = {},
): ProfileStore {
  const ownerName = opts.ownerName ?? 'test-profile';
  return {
    getRaw: vi.fn().mockReturnValue({
      name: ownerName,
      providerCredentials: currentCreds,
    } as Partial<Profile>),
    update: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
    resolveCredentialOwner: vi.fn((_name: string) => ownerName),
  } as unknown as ProfileStore;
}

function makeOpenAiProfileStore(options: {
  providerAccountId?: string | null;
  credentialOwner?: string | null;
  ownerCredentials?: ProviderCredentials | null;
}): ProfileStore {
  return {
    resolveProviderAccountId: vi.fn((_name: string) => options.providerAccountId ?? null),
    resolveCredentialOwner: vi.fn((_name: string) => options.credentialOwner ?? null),
    getRaw: vi.fn((_name: string) => ({
      name: options.credentialOwner ?? 'owner-profile',
      providerCredentials: options.ownerCredentials ?? null,
    })),
    update: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
    setWarmImage: vi.fn(),
  } as unknown as ProfileStore;
}

function makeProviderAccountStore(credentials: ProviderCredentials | null): ProviderAccountStore {
  return {
    get: vi.fn((id: string) => ({
      id,
      name: 'Team OpenAI',
      provider: 'openai',
      credentials,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      lastAuthenticatedAt: null,
      lastUsedAt: null,
    })),
    updateCredentials: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    touchLastUsed: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
    listLinkedProfileNames: vi.fn(),
  } as unknown as ProviderAccountStore;
}

describe('persistRefreshedCredentials', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists newer credentials from container', async () => {
    const containerCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: new Date('2026-03-20T14:00:00Z').getTime(),
      },
    });

    const currentCreds: MaxCredentials = {
      provider: 'max',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: '2026-03-20T12:00:00Z',
      clientId: 'my-client',
    };

    const cm = makeContainerManager(containerCreds);
    const ps = makeProfileStore(currentCreds);

    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger);

    expect(ps.update).toHaveBeenCalledWith('test-profile', {
      providerCredentials: expect.objectContaining({
        provider: 'max',
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        clientId: 'my-client', // preserved
      }),
    });
  });

  it('skips persist when container refresh token matches stored', async () => {
    const containerCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'new-access',
        refreshToken: 'same-refresh', // same as stored
        expiresAt: new Date('2026-03-20T14:00:00Z').getTime(),
      },
    });

    const currentCreds: MaxCredentials = {
      provider: 'max',
      accessToken: 'current-access',
      refreshToken: 'same-refresh', // matches container
      expiresAt: '2026-03-20T12:00:00Z',
    };

    const cm = makeContainerManager(containerCreds);
    const ps = makeProfileStore(currentCreds);

    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger);

    expect(ps.update).not.toHaveBeenCalled();
  });

  it('persists when refresh token differs even with older expiry', async () => {
    const containerCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh', // different from stored
        expiresAt: new Date('2026-03-20T11:00:00Z').getTime(), // older expiry
      },
    });

    const currentCreds: MaxCredentials = {
      provider: 'max',
      accessToken: 'current-access',
      refreshToken: 'old-refresh', // stale — already burned by Claude Code
      expiresAt: '2026-03-20T12:00:00Z', // newer expiry but invalid token
    };

    const cm = makeContainerManager(containerCreds);
    const ps = makeProfileStore(currentCreds);

    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger);

    expect(ps.update).toHaveBeenCalledWith('test-profile', {
      providerCredentials: expect.objectContaining({
        refreshToken: 'rotated-refresh',
      }),
    });
  });

  it('skips credential-file persistence for setup-token credentials', async () => {
    const cm = makeContainerManager('should-not-be-read');
    const ps = makeProfileStore({
      provider: 'max',
      authMode: 'setup-token',
      oauthToken: 'setup-token-123',
    });

    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger);

    expect(cm.readFile).not.toHaveBeenCalled();
    expect(ps.update).not.toHaveBeenCalled();
  });

  it('handles readFile failure gracefully', async () => {
    const cm = {
      readFile: vi.fn().mockRejectedValue(new Error('container gone')),
      spawn: vi.fn(),
      kill: vi.fn(),
      writeFile: vi.fn(),
      getStatus: vi.fn(),
      execInContainer: vi.fn(),
      execStreaming: vi.fn(),
    } as unknown as ContainerManager;

    const ps = makeProfileStore(null);

    // Should not throw
    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger);

    expect(ps.update).not.toHaveBeenCalled();
  });

  it('handles malformed JSON gracefully', async () => {
    const cm = makeContainerManager('not-json{{{');
    const ps = makeProfileStore(null);

    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger);

    expect(ps.update).not.toHaveBeenCalled();
  });

  it('handles missing OAuth fields gracefully', async () => {
    const cm = makeContainerManager(JSON.stringify({ claudeAiOauth: {} }));
    const ps = makeProfileStore(null);

    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger);

    expect(ps.update).not.toHaveBeenCalled();
  });

  it('persists rotated tokens to the credential owner, not the pod profile', async () => {
    // Simulate a derived profile running a pod whose auth is owned by a parent.
    const containerCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: new Date('2026-04-20T00:00:00Z').getTime(),
      },
    });

    const parentCreds: MaxCredentials = {
      provider: 'max',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: '2026-03-20T00:00:00Z',
      clientId: 'parent-client',
    };

    const cm = makeContainerManager(containerCreds);
    const ps = makeProfileStore(parentCreds, { ownerName: 'teamplanner-base' });

    await persistRefreshedCredentials('ctr-1', cm, ps, 'teamplanner-workspace', logger);

    expect(ps.resolveCredentialOwner).toHaveBeenCalledWith('teamplanner-workspace');
    expect(ps.update).toHaveBeenCalledWith(
      'teamplanner-base',
      expect.objectContaining({
        providerCredentials: expect.objectContaining({
          refreshToken: 'rotated-refresh',
          clientId: 'parent-client', // preserved from owner, not pod profile
        }),
      }),
    );
  });

  it('persists rotated credentials when owner still has the issued refresh token', async () => {
    const containerCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: new Date('2026-03-20T14:00:00Z').getTime(),
      },
    });

    const currentCreds: MaxCredentials = {
      provider: 'max',
      accessToken: 'issued-access',
      refreshToken: 'issued-refresh',
      expiresAt: '2026-03-20T12:00:00Z',
      subscriptionType: 'max',
    };

    const cm = makeContainerManager(containerCreds);
    const ps = makeProfileStore(currentCreds);

    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger, {
      owner: { type: 'profile', name: 'test-profile' },
      issuedRefreshToken: 'issued-refresh',
    });

    expect(ps.update).toHaveBeenCalledWith('test-profile', {
      providerCredentials: expect.objectContaining({
        refreshToken: 'rotated-refresh',
        subscriptionType: 'max',
      }),
    });
  });

  it('skips stale rotated credentials when owner advanced after container issue', async () => {
    const containerCreds = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'stale-access',
        refreshToken: 'stale-refresh',
        expiresAt: new Date('2026-03-20T14:00:00Z').getTime(),
      },
    });

    const currentCreds: MaxCredentials = {
      provider: 'max',
      accessToken: 'newer-access',
      refreshToken: 'newer-refresh',
      expiresAt: '2026-03-20T13:00:00Z',
    };

    const cm = makeContainerManager(containerCreds);
    const ps = makeProfileStore(currentCreds);

    await persistRefreshedCredentials('ctr-1', cm, ps, 'test-profile', logger, {
      owner: { type: 'profile', name: 'test-profile' },
      issuedRefreshToken: 'issued-refresh',
    });

    expect(ps.update).not.toHaveBeenCalled();
  });

  it('prevents an older overlapping pod from overwriting the latest owner refresh token', async () => {
    let storedCreds: MaxCredentials = {
      provider: 'max',
      accessToken: 'issued-access',
      refreshToken: 'issued-refresh',
      expiresAt: '2026-03-20T12:00:00Z',
      clientId: 'client-1',
    };

    const ps = {
      resolveCredentialOwner: vi.fn((_name: string) => 'owner-profile'),
      getRaw: vi.fn((_name: string) => ({
        name: 'owner-profile',
        providerCredentials: storedCreds,
      })),
      update: vi.fn((_name: string, changes: Record<string, unknown>) => {
        const next = changes.providerCredentials as MaxCredentials | undefined;
        if (next) storedCreds = next;
        return { name: 'owner-profile', providerCredentials: storedCreds } as Partial<Profile>;
      }),
      get: vi.fn(),
      create: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
    } as unknown as ProfileStore;

    const lineage = {
      owner: { type: 'profile' as const, name: 'owner-profile' },
      issuedRefreshToken: 'issued-refresh',
    };

    await persistRefreshedCredentials(
      'ctr-finished-first',
      makeContainerManager(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'first-access',
            refreshToken: 'first-refresh',
            expiresAt: new Date('2026-03-20T14:00:00Z').getTime(),
          },
        }),
      ),
      ps,
      'child-profile',
      logger,
      lineage,
    );

    await persistRefreshedCredentials(
      'ctr-finished-later',
      makeContainerManager(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'later-access',
            refreshToken: 'later-refresh',
            expiresAt: new Date('2026-03-20T15:00:00Z').getTime(),
          },
        }),
      ),
      ps,
      'child-profile',
      logger,
      lineage,
    );

    expect(ps.update).toHaveBeenCalledTimes(1);
    expect(storedCreds.refreshToken).toBe('first-refresh');
  });

  it('serializes preflight refreshes and re-reads the credential owner', async () => {
    let storedCreds: MaxCredentials = {
      provider: 'max',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: '2026-01-01T00:00:00.000Z',
      clientId: 'client-1',
      scopes: ['org:create_api_key', 'user:profile'],
      subscriptionType: 'max',
    };

    const ps = {
      resolveCredentialOwner: vi.fn((_name: string) => 'owner-profile'),
      getRaw: vi.fn((_name: string) => ({
        name: 'owner-profile',
        providerCredentials: storedCreds,
      })),
      update: vi.fn((_name: string, changes: Record<string, unknown>) => {
        const next = changes.providerCredentials as MaxCredentials | undefined;
        if (next) storedCreds = next;
        return { name: 'owner-profile', providerCredentials: storedCreds } as Partial<Profile>;
      }),
      get: vi.fn(),
      create: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
    } as unknown as ProfileStore;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string };
      expect(body.refresh_token).toBe('old-refresh');
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const [first, second] = await Promise.all([
      refreshAndPersistMaxCredentials(ps, 'child-profile', storedCreds, logger),
      refreshAndPersistMaxCredentials(ps, 'child-profile', storedCreds, logger),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ps.resolveCredentialOwner).toHaveBeenCalledWith('child-profile');
    expect(ps.update).toHaveBeenCalledTimes(1);
    expect(first.credentials.refreshToken).toBe('new-refresh');
    expect(first.lineage).toEqual({
      owner: { type: 'profile', name: 'owner-profile' },
      issuedRefreshToken: 'new-refresh',
    });
    expect(second.credentials.refreshToken).toBe('new-refresh');
    expect(storedCreds.refreshToken).toBe('new-refresh');
  });
});

describe('persistOpenAiAuthJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists updated Codex auth.json to a provider account owner', async () => {
    const authJson = JSON.stringify({ tokens: { access_token: 'fresh' } });
    const cm = makeContainerManager(authJson);
    const ps = makeOpenAiProfileStore({ providerAccountId: 'team-openai' });
    const providerAccountStore = makeProviderAccountStore({
      provider: 'openai',
      authMode: 'chatgpt',
      authJson: JSON.stringify({ tokens: { access_token: 'old' } }),
    });

    await persistOpenAiAuthJson('ctr-1', cm, ps, 'child-profile', logger, {
      providerAccountStore,
    });

    expect(providerAccountStore.updateCredentials).toHaveBeenCalledWith('team-openai', {
      provider: 'openai',
      authMode: 'chatgpt',
      authJson,
    });
    expect(ps.update).not.toHaveBeenCalled();
  });

  it('persists updated Codex auth.json to a legacy profile credential owner', async () => {
    const authJson = JSON.stringify({ tokens: { access_token: 'fresh' } });
    const cm = makeContainerManager(authJson);
    const ps = makeOpenAiProfileStore({
      credentialOwner: 'base-profile',
      ownerCredentials: {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: JSON.stringify({ tokens: { access_token: 'old' } }),
      },
    });

    await persistOpenAiAuthJson('ctr-1', cm, ps, 'child-profile', logger);

    expect(ps.update).toHaveBeenCalledWith('base-profile', {
      providerCredentials: {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson,
      },
    });
  });

  it('does not read or persist Codex auth.json when no auth owner exists', async () => {
    const cm = makeContainerManager(JSON.stringify({ tokens: { access_token: 'fresh' } }));
    const ps = makeOpenAiProfileStore({});

    await persistOpenAiAuthJson('ctr-1', cm, ps, 'child-profile', logger);

    expect(cm.readFile).not.toHaveBeenCalled();
    expect(ps.update).not.toHaveBeenCalled();
  });

  it('skips invalid Codex auth.json content', async () => {
    const cm = makeContainerManager('{not-json');
    const ps = makeOpenAiProfileStore({ providerAccountId: 'team-openai' });
    const providerAccountStore = makeProviderAccountStore(null);

    await persistOpenAiAuthJson('ctr-1', cm, ps, 'child-profile', logger, {
      providerAccountStore,
    });

    expect(providerAccountStore.updateCredentials).not.toHaveBeenCalled();
  });
});
