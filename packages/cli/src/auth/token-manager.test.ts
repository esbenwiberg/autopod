import { describe, expect, it } from 'vitest';
import { shouldUseDevTokenForDaemonUrl } from './token-manager.js';

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
