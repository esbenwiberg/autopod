import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAzureTokenCache, getAzureToken } from './azure-token.js';

const logger = pino({ level: 'silent' });

const SCOPE = 'https://cognitiveservices.azure.com/.default';

describe('getAzureToken', () => {
  beforeEach(() => {
    clearAzureTokenCache();
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@azure/identity');
    vi.doUnmock('node:child_process');
  });

  it('returns a token from DefaultAzureCredential', async () => {
    const getToken = vi.fn().mockResolvedValue({
      token: 'mi-token-1',
      expiresOnTimestamp: Date.now() + 3600_000,
    });
    vi.doMock('@azure/identity', () => ({
      DefaultAzureCredential: vi.fn().mockImplementation(() => ({ getToken })),
    }));

    const result = await getAzureToken(SCOPE, logger);
    expect(result.token).toBe('mi-token-1');
    expect(getToken).toHaveBeenCalledWith(SCOPE);
  });

  it('caches the token across calls within the validity window', async () => {
    const getToken = vi.fn().mockResolvedValue({
      token: 'cached-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    });
    vi.doMock('@azure/identity', () => ({
      DefaultAzureCredential: vi.fn().mockImplementation(() => ({ getToken })),
    }));

    const a = await getAzureToken(SCOPE, logger);
    const b = await getAzureToken(SCOPE, logger);
    expect(a.token).toBe(b.token);
    // Single underlying acquisition despite two callers
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('falls back to az CLI when DefaultAzureCredential throws', async () => {
    vi.doMock('@azure/identity', () => ({
      DefaultAzureCredential: vi.fn().mockImplementation(() => ({
        getToken: vi.fn().mockRejectedValue(new Error('no managed identity')),
      })),
    }));
    const execFile = vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        cb(null, {
          stdout: JSON.stringify({
            accessToken: 'az-cli-token',
            expiresOn: new Date(Date.now() + 3600_000).toISOString(),
          }),
          stderr: '',
        });
      },
    );
    vi.doMock('node:child_process', () => ({ execFile }));

    const result = await getAzureToken(SCOPE, logger);
    expect(result.token).toBe('az-cli-token');
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

  it('throws with guidance when both managed identity and az CLI fail', async () => {
    vi.doMock('@azure/identity', () => ({
      DefaultAzureCredential: vi.fn().mockImplementation(() => ({
        getToken: vi.fn().mockRejectedValue(new Error('no identity available')),
      })),
    }));
    vi.doMock('node:child_process', () => ({
      execFile: (
        _cmd: string,
        _args: readonly string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => cb(new Error('az not installed')),
    }));

    await expect(getAzureToken(SCOPE, logger)).rejects.toThrow(/Azure auth failed/);
  });

  it('keys cache by scope so two scopes do not collide', async () => {
    const getToken = vi.fn().mockImplementation(async (scope: string) => ({
      token: `token-for-${scope}`,
      expiresOnTimestamp: Date.now() + 3600_000,
    }));
    vi.doMock('@azure/identity', () => ({
      DefaultAzureCredential: vi.fn().mockImplementation(() => ({ getToken })),
    }));

    const a = await getAzureToken('https://management.azure.com/.default', logger);
    const b = await getAzureToken('https://cognitiveservices.azure.com/.default', logger);
    expect(a.token).not.toBe(b.token);
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});
