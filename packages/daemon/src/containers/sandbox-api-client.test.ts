import { describe, expect, it } from 'vitest';
import { egressPolicyForMode, pickSandboxTier } from './sandbox-api-client.js';

const GB = 1024 * 1024 * 1024;

describe('pickSandboxTier', () => {
  it('falls back to the default tier when no memory hint is given', () => {
    expect(pickSandboxTier(undefined, 'L')).toBe('L');
    expect(pickSandboxTier(0, 'M')).toBe('M');
    expect(pickSandboxTier(-1, 'S')).toBe('S');
  });

  it('picks the smallest tier whose ceiling satisfies the request', () => {
    expect(pickSandboxTier(256 * 1024 * 1024, 'L')).toBe('XS'); // 0.25 GB → 0.5 GB tier
    expect(pickSandboxTier(512 * 1024 * 1024, 'L')).toBe('XS'); // exactly 0.5 GB
    expect(pickSandboxTier(768 * 1024 * 1024, 'L')).toBe('S'); // 0.75 GB → 1 GB tier
    expect(pickSandboxTier(1 * GB, 'L')).toBe('S');
    expect(pickSandboxTier(1.5 * GB, 'XS')).toBe('M'); // overrides a smaller default
    expect(pickSandboxTier(2 * GB, 'XS')).toBe('M');
    expect(pickSandboxTier(3 * GB, 'XS')).toBe('L');
    expect(pickSandboxTier(4 * GB, 'XS')).toBe('L');
  });

  it('clamps requests above the largest tier to L', () => {
    expect(pickSandboxTier(64 * GB, 'XS')).toBe('L');
  });
});

describe('egressPolicyForMode', () => {
  it('maps allow-all (and undefined) to default Allow with no rules', () => {
    expect(egressPolicyForMode('allow-all')).toEqual({ defaultAction: 'Allow', hostRules: [] });
    expect(egressPolicyForMode(undefined)).toEqual({ defaultAction: 'Allow', hostRules: [] });
    // Hosts are irrelevant to allow-all.
    expect(egressPolicyForMode('allow-all', ['api.github.com'])).toEqual({
      defaultAction: 'Allow',
      hostRules: [],
    });
  });

  it('maps deny-all to default Deny with no rules', () => {
    expect(egressPolicyForMode('deny-all', ['ignored.example.com'])).toEqual({
      defaultAction: 'Deny',
      hostRules: [],
    });
  });

  it('maps restricted to default Deny plus an Allow rule per host', () => {
    expect(egressPolicyForMode('restricted', ['api.github.com', 'pypi.org'])).toEqual({
      defaultAction: 'Deny',
      hostRules: [
        { pattern: 'api.github.com', action: 'Allow' },
        { pattern: 'pypi.org', action: 'Allow' },
      ],
    });
  });

  it('restricted with no hosts is effectively deny-all', () => {
    expect(egressPolicyForMode('restricted', [])).toEqual({ defaultAction: 'Deny', hostRules: [] });
  });
});
