import { describe, expect, it } from 'vitest';
import {
  shouldUseCachedTokenAfterRefreshFailure,
  shouldUseDevTokenForDaemonUrl,
} from './token-manager.js';

describe('shouldUseDevTokenForDaemonUrl', () => {
  it('allows dev tokens for local daemon URLs', () => {
    expect(shouldUseDevTokenForDaemonUrl(undefined)).toBe(true);
    expect(shouldUseDevTokenForDaemonUrl('http://localhost:3100')).toBe(true);
    expect(shouldUseDevTokenForDaemonUrl('http://127.0.0.1:3100')).toBe(true);
    expect(shouldUseDevTokenForDaemonUrl('http://[::1]:3100')).toBe(true);
  });

  it('does not use dev tokens for remote daemon URLs', () => {
    expect(
      shouldUseDevTokenForDaemonUrl(
        'http://autopod-daemon-ewi.swedencentral.cloudapp.azure.com:3100',
      ),
    ).toBe(false);
    expect(shouldUseDevTokenForDaemonUrl('https://daemon.example.com')).toBe(false);
  });

  it('treats malformed daemon config as non-local', () => {
    expect(shouldUseDevTokenForDaemonUrl('not a url')).toBe(false);
  });
});

describe('shouldUseCachedTokenAfterRefreshFailure', () => {
  it('keeps using an unexpired access token when silent refresh is unavailable', () => {
    const now = Date.parse('2026-06-26T10:00:00.000Z');
    expect(shouldUseCachedTokenAfterRefreshFailure(new Date('2026-06-26T10:01:00.000Z'), now)).toBe(
      true,
    );
  });

  it('does not use an expired access token', () => {
    const now = Date.parse('2026-06-26T10:00:00.000Z');
    expect(shouldUseCachedTokenAfterRefreshFailure(new Date('2026-06-26T09:59:59.000Z'), now)).toBe(
      false,
    );
  });
});
