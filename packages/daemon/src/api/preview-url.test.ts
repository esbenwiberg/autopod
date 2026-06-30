import { describe, expect, it } from 'vitest';
import {
  isLoopbackHost,
  resolvePublicPreviewHost,
  rewriteLoopbackPreviewUrl,
} from './preview-url.js';

describe('preview URL rewriting', () => {
  it('rewrites loopback preview URLs to the request host while preserving the app port', () => {
    expect(
      rewriteLoopbackPreviewUrl('http://127.0.0.1:32123', {
        requestHost: 'autopod-daemon-ewi.swedencentral.cloudapp.azure.com',
      }),
    ).toBe('http://autopod-daemon-ewi.swedencentral.cloudapp.azure.com:32123');
  });

  it('prefers configured public host over forwarded/request headers', () => {
    expect(
      rewriteLoopbackPreviewUrl('http://localhost:32123', {
        requestHost: 'localhost:3100',
        forwardedHost: 'proxy.example.com',
        publicHost: 'vm.example.com',
      }),
    ).toBe('http://vm.example.com:32123');
  });

  it('uses the forwarded host behind a reverse proxy and strips its daemon port', () => {
    expect(
      rewriteLoopbackPreviewUrl('http://127.0.0.1:32123', {
        requestHost: '127.0.0.1:3100',
        forwardedHost: 'autopod.example.com:443',
      }),
    ).toBe('http://autopod.example.com:32123');
  });

  it('leaves loopback URLs untouched for local callers', () => {
    expect(
      rewriteLoopbackPreviewUrl('http://127.0.0.1:32123', {
        requestHost: 'localhost:3100',
      }),
    ).toBe('http://127.0.0.1:32123');
  });

  it('does not rewrite already-public preview URLs', () => {
    expect(
      rewriteLoopbackPreviewUrl('http://vm.example.com:32123', {
        requestHost: 'other.example.com',
      }),
    ).toBe('http://vm.example.com:32123');
  });

  it('supports an explicit public scheme for TLS-terminated preview ports', () => {
    expect(
      rewriteLoopbackPreviewUrl('http://127.0.0.1:32123', {
        publicHost: 'preview.example.com',
        publicScheme: 'https',
      }),
    ).toBe('https://preview.example.com:32123');
  });

  it('parses comma-separated forwarded hosts', () => {
    expect(
      resolvePublicPreviewHost({
        forwardedHost: 'preview.example.com, internal-proxy.local',
      }),
    ).toBe('preview.example.com');
  });

  it('treats loopback-like hosts as local', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.42.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(true);
    expect(isLoopbackHost('preview.example.com')).toBe(false);
  });
});
