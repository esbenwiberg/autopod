import { describe, expect, it } from 'vitest';
import { egressPolicyForMode } from './sandbox-api-client.js';

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
