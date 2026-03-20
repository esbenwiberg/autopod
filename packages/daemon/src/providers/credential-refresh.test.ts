import type { MaxCredentials } from '@autopod/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshOAuthToken } from './credential-refresh.js';

const logger = pino({ level: 'silent' });

describe('refreshOAuthToken', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it('skips refresh when token is still valid (>5 min left)', async () => {
    const creds: MaxCredentials = {
      provider: 'max',
      accessToken: 'still-good',
      refreshToken: 'refresh-1',
      expiresAt: new Date('2026-03-20T12:30:00Z').toISOString(), // 30 min left
    };

    const result = await refreshOAuthToken(creds, logger);

    expect(result).toBe(creds); // Same object reference — no refresh
  });

  it('refreshes when token expires within 5 minutes', async () => {
    const creds: MaxCredentials = {
      provider: 'max',
      accessToken: 'about-to-expire',
      refreshToken: 'refresh-old',
      expiresAt: new Date('2026-03-20T12:03:00Z').toISOString(), // 3 min left
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    });

    const result = await refreshOAuthToken(creds, logger);

    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.provider).toBe('max');

    // Verify it called the right endpoint
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://platform.claude.com/v1/oauth/token',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('refresh_token'),
      }),
    );
  });

  it('throws on 401 (revoked token)', async () => {
    const creds: MaxCredentials = {
      provider: 'max',
      accessToken: 'expired',
      refreshToken: 'revoked-refresh',
      expiresAt: new Date('2026-03-20T11:00:00Z').toISOString(), // already expired
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(refreshOAuthToken(creds, logger)).rejects.toThrow(
      'refresh token expired or revoked',
    );
  });

  it('retries once on 500 error', async () => {
    const creds: MaxCredentials = {
      provider: 'max',
      accessToken: 'expired',
      refreshToken: 'refresh-retry',
      expiresAt: new Date('2026-03-20T11:00:00Z').toISOString(),
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'recovered-access',
          refresh_token: 'recovered-refresh',
          expires_in: 3600,
        }),
      });

    globalThis.fetch = fetchMock;

    // Need to advance timers for the 1s retry delay
    const promise = refreshOAuthToken(creds, logger);
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;

    expect(result.accessToken).toBe('recovered-access');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves custom clientId through refresh', async () => {
    const creds: MaxCredentials = {
      provider: 'max',
      accessToken: 'expired',
      refreshToken: 'refresh-1',
      expiresAt: new Date('2026-03-20T11:00:00Z').toISOString(),
      clientId: 'custom-client-id',
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'new',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    });

    const result = await refreshOAuthToken(creds, logger);

    expect(result.clientId).toBe('custom-client-id');

    // Verify custom client ID was sent in the request
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall?.[1]?.body as string);
    expect(body.client_id).toBe('custom-client-id');
  });
});
