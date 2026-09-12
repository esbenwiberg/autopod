import type { AuthToken } from '@autopod/shared';
import { describe, expect, it, vi } from 'vitest';

const recoveredToken: AuthToken = {
  accessToken: 'recovered-access-token',
  refreshToken: '',
  expiresAt: '2099-01-01T00:00:00.000Z',
  userId: 'user-1',
  displayName: 'Recovered User',
  email: 'recovered@example.com',
  roles: [],
};

const mocks = vi.hoisted(() => ({
  getAccounts: vi.fn(async () => [{ localAccountId: 'account-1' }]),
  readCredentials: vi.fn(() => null),
  refreshToken: vi.fn(async () => recoveredToken),
  writeCredentials: vi.fn(),
}));

vi.mock('../config/config-store.js', () => ({
  get: () => 'https://daemon.example.com',
}));

vi.mock('../config/credential-store.js', () => ({
  deleteCredentials: vi.fn(),
  readCredentials: mocks.readCredentials,
  writeCredentials: mocks.writeCredentials,
}));

vi.mock('./msal-cache.js', () => ({ deleteMsalCache: vi.fn() }));

vi.mock('./msal-client.js', () => ({
  MsalClient: class {
    getAccounts = mocks.getAccounts;
    refreshToken = mocks.refreshToken;
  },
}));

const { getToken, initMsal } = await import('./token-manager.js');

describe('getToken cached-session recovery', () => {
  it('rebuilds missing access credentials from the persisted MSAL session', async () => {
    initMsal('client-id', 'tenant-id');

    await expect(getToken()).resolves.toBe('recovered-access-token');
    expect(mocks.getAccounts).toHaveBeenCalledOnce();
    expect(mocks.refreshToken).toHaveBeenCalledOnce();
    expect(mocks.writeCredentials).toHaveBeenCalledWith(recoveredToken);
  });
});
