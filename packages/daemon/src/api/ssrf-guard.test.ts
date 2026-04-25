import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPrivateIp, isPrivateUrl } from './ssrf-guard.js';

describe('isPrivateIp', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '169.254.169.254',
    '169.254.0.1',
    '192.168.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '100.64.0.1',
    '100.127.255.255',
  ])('rejects private IPv4 %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.63.0.1', '100.128.0.1'])(
    'accepts public IPv4 %s',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );

  it.each([
    '::',
    '::1',
    'fc00::1',
    'fd00::1',
    'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::1',
    'feb0::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
  ])('rejects private IPv6 %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['2001:4860:4860::8888', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'accepts public IPv6 %s',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe('isPrivateUrl', () => {
  it.each([
    'http://localhost/',
    'http://localhost:5000/x',
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8080/',
    'http://[fe80::1]/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/',
    'http://something.internal/',
    'http://service.local/',
  ])('rejects %s', (url) => {
    expect(isPrivateUrl(url)).toBe(true);
  });

  it.each([
    'https://api.github.com/',
    'https://example.com/path',
    'https://8.8.8.8/',
    'https://[2001:4860:4860::8888]/',
  ])('accepts %s', (url) => {
    expect(isPrivateUrl(url)).toBe(false);
  });

  it('blocks malformed URLs', () => {
    expect(isPrivateUrl('not a url')).toBe(true);
    expect(isPrivateUrl('')).toBe(true);
  });

  it('strips trailing dot in metadata FQDN', () => {
    expect(isPrivateUrl('http://metadata.google.internal./')).toBe(true);
  });
});

describe('assertPublicUrl', () => {
  it('rejects malformed URL without DNS', async () => {
    const result = await assertPublicUrl('not a url', {
      resolver: () => {
        throw new Error('resolver should not be called');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('malformed');
  });

  it('rejects unsupported protocol', async () => {
    const result = await assertPublicUrl('file:///etc/passwd', {
      resolver: () => {
        throw new Error('resolver should not be called');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('protocol');
  });

  it('rejects private hostname literal without DNS lookup', async () => {
    let resolverCalled = false;
    const result = await assertPublicUrl('http://169.254.169.254/x', {
      resolver: async () => {
        resolverCalled = true;
        return ['8.8.8.8'];
      },
    });
    expect(result.ok).toBe(false);
    expect(resolverCalled).toBe(false);
  });

  it('accepts an IP literal that is public without DNS lookup', async () => {
    let resolverCalled = false;
    const result = await assertPublicUrl('https://8.8.8.8/', {
      resolver: async () => {
        resolverCalled = true;
        return ['8.8.8.8'];
      },
    });
    expect(result.ok).toBe(true);
    expect(resolverCalled).toBe(false);
    expect(result.resolvedIps).toEqual(['8.8.8.8']);
  });

  it('blocks "evil.com → 169.254.169.254" hostname pointer attack', async () => {
    const result = await assertPublicUrl('https://attacker.example/x', {
      resolver: async () => ['169.254.169.254'],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('169.254.169.254');
  });

  it('blocks if any resolved record is private (defeats split-record DNS rebind)', async () => {
    const result = await assertPublicUrl('https://attacker.example/x', {
      resolver: async () => ['8.8.8.8', '127.0.0.1'],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('127.0.0.1');
  });

  it('accepts a hostname whose A records are all public', async () => {
    const result = await assertPublicUrl('https://api.github.com/repos', {
      resolver: async () => ['140.82.112.5', '140.82.114.5'],
    });
    expect(result.ok).toBe(true);
    expect(result.resolvedIps).toEqual(['140.82.112.5', '140.82.114.5']);
  });

  it('rejects when DNS returns empty', async () => {
    const result = await assertPublicUrl('https://nonexistent.example/x', {
      resolver: async () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('no records');
  });

  it('rejects when DNS resolution fails', async () => {
    const result = await assertPublicUrl('https://broken.example/x', {
      resolver: async () => {
        throw new Error('NXDOMAIN');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('NXDOMAIN');
  });
});
