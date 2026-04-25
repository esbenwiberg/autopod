import type { ScanFinding, SecurityScanPolicy } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { decide, getPreset, resolvePolicy } from './scan-policy.js';

describe('scan-policy presets', () => {
  it('default preset enables both checkpoints with secrets-only', () => {
    const p = getPreset('default');
    expect(p.detectors.secrets.enabled).toBe(true);
    expect(p.detectors.pii.enabled).toBe(false);
    expect(p.provisioning.enabled).toBe(true);
    expect(p.provisioning.scope).toBe('auto');
    expect(p.push.onSecret).toBe('block');
  });

  it('strict preset blocks every detector at every checkpoint', () => {
    const p = getPreset('strict');
    expect(p.detectors.injection.enabled).toBe(true);
    expect(p.provisioning.scope).toBe('full');
    expect(p.provisioning.onSecret).toBe('block');
    expect(p.push.onPii).toBe('block');
  });

  it('relaxed preset disables provisioning and only blocks secrets on push', () => {
    const p = getPreset('relaxed');
    expect(p.provisioning.enabled).toBe(false);
    expect(p.push.onSecret).toBe('block');
    expect(p.push.onPii).toBe('warn');
  });

  it('returns isolated copies — mutations do not leak', () => {
    const a = getPreset('default');
    a.provisioning.enabled = false;
    const b = getPreset('default');
    expect(b.provisioning.enabled).toBe(true);
  });
});

describe('resolvePolicy', () => {
  it('falls back to the named preset when profile policy is null', () => {
    const resolved = resolvePolicy(null, 'strict');
    expect(resolved.provisioning.scope).toBe('full');
  });

  it('returns the profile policy when supplied (still cloned)', () => {
    const profilePolicy: SecurityScanPolicy = getPreset('default');
    profilePolicy.provisioning.onSecret = 'escalate';
    const resolved = resolvePolicy(profilePolicy);
    expect(resolved.provisioning.onSecret).toBe('escalate');
    resolved.provisioning.onSecret = 'block';
    expect(profilePolicy.provisioning.onSecret).toBe('escalate'); // not mutated
  });
});

describe('decide()', () => {
  const policy = getPreset('default');

  function finding(overrides: Partial<ScanFinding> = {}): ScanFinding {
    return {
      detector: 'secrets',
      severity: 'high',
      file: 'src/x.ts',
      snippet: '[REDACTED]',
      ...overrides,
    };
  }

  it('returns pass when there are no findings', () => {
    expect(decide({ findings: [], checkpoint: 'provisioning', policy })).toBe('pass');
  });

  it('returns the highest-ranked outcome across findings', () => {
    const result = decide({
      findings: [finding({ detector: 'pii' }), finding({ detector: 'secrets' })],
      checkpoint: 'push',
      policy,
    });
    // push: secrets=block, pii=warn → block wins
    expect(result).toBe('block');
  });

  it('returns pass when the checkpoint is disabled', () => {
    const disabled = getPreset('relaxed');
    expect(decide({ findings: [finding()], checkpoint: 'provisioning', policy: disabled })).toBe(
      'pass',
    );
  });

  it('rewrites push block→escalate for workspace pods', () => {
    const result = decide({
      findings: [finding()],
      checkpoint: 'push',
      policy,
      isWorkspacePod: true,
    });
    expect(result).toBe('escalate');
  });

  it('does NOT rewrite block→escalate at provisioning for workspace pods', () => {
    const strict = getPreset('strict');
    const result = decide({
      findings: [finding()],
      checkpoint: 'provisioning',
      policy: strict,
      isWorkspacePod: true,
    });
    expect(result).toBe('block');
  });
});
