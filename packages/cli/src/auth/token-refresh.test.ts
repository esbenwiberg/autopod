import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AuthToken } from '@autopod/shared';
import type { AccountInfo } from '@azure/msal-node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpHome = path.join(os.tmpdir(), `autopod-token-refresh-${Date.now()}-${Math.random()}`);

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmpHome };
});

const { MsalClient } = await import('./msal-client.js');
const { getToken, initMsal } = await import('./token-manager.js');
const { writeCredentials } = await import('../config/credential-store.js');

function token(accessToken: string, expiresAt: string): AuthToken {
  return {
    accessToken,
    refreshToken: '',
    expiresAt,
    userId: 'user-1',
    displayName: 'Test User',
    email: 'test@example.com',
    roles: [],
  };
}

describe('persistent token refresh', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpHome, '.autopod'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('silently refreshes after the persisted access token expires', async () => {
    writeCredentials(token('expired', '2000-01-01T00:00:00.000Z'));
    const account = { homeAccountId: 'account-1' } as AccountInfo;
    vi.spyOn(MsalClient.prototype, 'getAccounts').mockResolvedValue([account]);
    vi.spyOn(MsalClient.prototype, 'refreshToken').mockResolvedValue(
      token('refreshed', '2099-01-01T00:00:00.000Z'),
    );
    initMsal('client-id', 'tenant-id');

    await expect(getToken()).resolves.toBe('refreshed');
  });
});
