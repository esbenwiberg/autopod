import type { MaxCredentials, Profile } from '@autopod/shared';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ProfileStore } from '../profiles/index.js';
import { persistRefreshedCredentials } from './credential-persistence.js';

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

function makeProfileStore(currentCreds: MaxCredentials | null): ProfileStore {
  return {
    getRaw: vi.fn().mockReturnValue({
      name: 'test-profile',
      providerCredentials: currentCreds,
    } as Partial<Profile>),
    update: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
  } as unknown as ProfileStore;
}

describe('persistRefreshedCredentials', () => {
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
});
