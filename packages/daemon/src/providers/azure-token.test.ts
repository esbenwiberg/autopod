import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAzureTokenCache, getAzureToken } from './azure-token.js';

const logger = pino({ level: 'silent' });

const SCOPE = 'https://cognitiveservices.azure.com/.default';

type ExecFileCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function mockAzCliToken(token = 'az-cli-token') {
  const execFile = vi.fn(
    (_cmd: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, {
        stdout: JSON.stringify({
          accessToken: token,
          expiresOn: new Date(Date.now() + 3600_000).toISOString(),
        }),
        stderr: '',
      });
    },
  );
  vi.doMock('node:child_process', () => ({ execFile }));
  return execFile;
}

function mockAzCliFailure() {
  const execFile = vi.fn(
    (_cmd: string, _args: readonly string[], _opts: unknown, cb: ExecFileCallback) =>
      cb(new Error('az not installed')),
  );
  vi.doMock('node:child_process', () => ({ execFile }));
  return execFile;
}

function mockDefaultAzureCredentialToken(token: string) {
  const getToken = vi.fn().mockResolvedValue({
    token,
    expiresOnTimestamp: Date.now() + 3600_000,
  });
  vi.doMock('@azure/identity', () => ({
    // biome-ignore lint/complexity/useArrowFunction: vitest 4 requires regular functions for class mocks
    DefaultAzureCredential: vi.fn().mockImplementation(function () {
      return { getToken };
    }),
  }));
  return getToken;
}

function mockDefaultAzureCredentialFailure(message = 'no identity available') {
  const getToken = vi.fn().mockRejectedValue(new Error(message));
  vi.doMock('@azure/identity', () => ({
    // biome-ignore lint/complexity/useArrowFunction: vitest 4 requires regular functions for class mocks
    DefaultAzureCredential: vi.fn().mockImplementation(function () {
      return { getToken };
    }),
  }));
  return getToken;
}

describe('getAzureToken', () => {
  beforeEach(() => {
    clearAzureTokenCache();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@azure/identity');
    vi.doUnmock('node:child_process');
  });

  it('falls back to DefaultAzureCredential when az CLI is unavailable', async () => {
    mockAzCliFailure();
    const getToken = mockDefaultAzureCredentialToken('mi-token-1');

    const result = await getAzureToken(SCOPE, logger);
    expect(result.token).toBe('mi-token-1');
    expect(getToken).toHaveBeenCalledWith(SCOPE);
  });

  it('caches the token across calls within the validity window', async () => {
    mockAzCliFailure();
    const getToken = mockDefaultAzureCredentialToken('cached-token');

    const a = await getAzureToken(SCOPE, logger);
    const b = await getAzureToken(SCOPE, logger);
    expect(a.token).toBe(b.token);
    // Single underlying acquisition despite two callers
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('prefers az CLI when both az CLI and DefaultAzureCredential are available', async () => {
    const getToken = mockDefaultAzureCredentialToken('mi-token-1');
    const execFile = mockAzCliToken();

    const result = await getAzureToken(SCOPE, logger);
    expect(result.token).toBe('az-cli-token');
    expect(getToken).not.toHaveBeenCalled();
    // az is invoked with the resource form (no `/.default` suffix)
    expect(execFile).toHaveBeenCalledWith(
      'az',
      [
        'account',
        'get-access-token',
        '--resource',
        'https://cognitiveservices.azure.com',
        '--output',
        'json',
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('binds Azure CLI token acquisition to the requested tenant', async () => {
    mockDefaultAzureCredentialToken('mi-token-1');
    const execFile = mockAzCliToken();

    await getAzureToken(SCOPE, logger, {
      tenantId: 'ee357b2a-1bf9-42a6-baab-9772d85b28c1',
    });

    expect(execFile).toHaveBeenCalledWith(
      'az',
      [
        'account',
        'get-access-token',
        '--resource',
        'https://cognitiveservices.azure.com',
        '--tenant',
        'ee357b2a-1bf9-42a6-baab-9772d85b28c1',
        '--output',
        'json',
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('throws with guidance when both managed identity and az CLI fail', async () => {
    mockAzCliFailure();
    mockDefaultAzureCredentialFailure();

    await expect(getAzureToken(SCOPE, logger)).rejects.toThrow(/Azure auth failed/);
  });

  it('keys cache by scope so two scopes do not collide', async () => {
    mockAzCliFailure();
    const getToken = vi.fn().mockImplementation(async (scope: string) => ({
      token: `token-for-${scope}`,
      expiresOnTimestamp: Date.now() + 3600_000,
    }));
    vi.doMock('@azure/identity', () => ({
      // biome-ignore lint/complexity/useArrowFunction: vitest 4 requires regular functions for class mocks
      DefaultAzureCredential: vi.fn().mockImplementation(function () {
        return { getToken };
      }),
    }));

    const a = await getAzureToken('https://management.azure.com/.default', logger);
    const b = await getAzureToken('https://cognitiveservices.azure.com/.default', logger);
    expect(a.token).not.toBe(b.token);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('keys cache by tenant so guest-tenant tokens do not collide', async () => {
    const execFile = vi.fn(
      (_cmd: string, args: readonly string[], _opts: unknown, cb: ExecFileCallback) => {
        const tenantIndex = args.indexOf('--tenant');
        const tenant = tenantIndex >= 0 ? args[tenantIndex + 1] : 'default';
        cb(null, {
          stdout: JSON.stringify({
            accessToken: `token-for-${tenant}`,
            expiresOn: new Date(Date.now() + 3600_000).toISOString(),
          }),
          stderr: '',
        });
      },
    );
    vi.doMock('node:child_process', () => ({ execFile }));

    const home = await getAzureToken(SCOPE, logger, {
      tenantId: '0d3aa8f9-8168-4bc2-bda1-c3972e6d9352',
    });
    const guest = await getAzureToken(SCOPE, logger, {
      tenantId: 'ee357b2a-1bf9-42a6-baab-9772d85b28c1',
    });

    expect(home.token).not.toBe(guest.token);
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});
