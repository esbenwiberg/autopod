import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMIT_POLL_INTERVAL_MS,
  CONTAINER_APP_PORT,
  CONTAINER_CLEANUP_TIMEOUT_MS,
  PREVIEW_AUTO_STOP_MS,
  allocateHostPort,
  hostnameFromUrl,
  nativePreviewEmails,
  parsePreviewPort,
  portFromUrl,
} from './resource-policy.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe('resource policy', () => {
  it('keeps the original port bounds and timing constants', () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0);
    expect(allocateHostPort()).toBe(10000);
    random.mockReturnValue(0.999999);
    expect(allocateHostPort()).toBe(48999);
    expect([
      CONTAINER_APP_PORT,
      PREVIEW_AUTO_STOP_MS,
      CONTAINER_CLEANUP_TIMEOUT_MS,
      COMMIT_POLL_INTERVAL_MS,
    ]).toEqual([3000, 600000, 15000, 60000]);
  });
  it('reads the native allowlist on every invocation', () => {
    vi.stubEnv(
      'AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS',
      ' a@invalid.example, b@invalid.example  c@invalid.example ',
    );
    expect(nativePreviewEmails()).toEqual([
      'a@invalid.example',
      'b@invalid.example',
      'c@invalid.example',
    ]);
    vi.stubEnv('AUTOPOD_SANDBOX_NATIVE_PREVIEW_EMAILS', '');
    expect(nativePreviewEmails()).toEqual([]);
  });
  it('preserves URL parsing and invalid-input fallbacks', () => {
    expect(parsePreviewPort('http://127.0.0.1:1234')).toBe(1234);
    expect(parsePreviewPort('http://127.0.0.1')).toBeNull();
    expect(parsePreviewPort('invalid')).toBeNull();
    expect(hostnameFromUrl('invalid')).toBe('host.docker.internal');
    expect(hostnameFromUrl('https://daemon.example:444')).toBe('daemon.example');
    expect(portFromUrl('https://daemon.example')).toBe(443);
    expect(portFromUrl('http://daemon.example')).toBe(80);
    expect(portFromUrl('http://daemon.example:3210')).toBe(3210);
    expect(portFromUrl('invalid')).toBe(3100);
  });
});
