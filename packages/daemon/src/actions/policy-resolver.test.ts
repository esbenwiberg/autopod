import type { ActionPolicy, Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { resolveEffectiveActionPolicy } from './policy-resolver.js';

const baseProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    name: 'test',
    deployment: null,
    actionPolicy: null,
    ...overrides,
  }) as Profile;

const policy = (overrides: Partial<ActionPolicy> = {}): ActionPolicy => ({
  enabledGroups: [],
  sanitization: { preset: 'standard' },
  ...overrides,
});

describe('resolveEffectiveActionPolicy', () => {
  it('returns null when profile has no policy and deployment is disabled', () => {
    const result = resolveEffectiveActionPolicy(baseProfile());
    expect(result).toBeNull();
  });

  it('returns null when profile has no policy and deployment.enabled is false', () => {
    const result = resolveEffectiveActionPolicy(
      baseProfile({ deployment: { enabled: false, env: {} } }),
    );
    expect(result).toBeNull();
  });

  it('synthesizes a minimal policy with deploy when deployment is enabled and policy is null', () => {
    const result = resolveEffectiveActionPolicy(
      baseProfile({ deployment: { enabled: true, env: {} } }),
    );
    expect(result).toEqual({
      enabledGroups: ['deploy'],
      sanitization: { preset: 'standard' },
    });
  });

  it('returns the policy unchanged when deployment is disabled', () => {
    const ap = policy({ enabledGroups: ['github-prs'] });
    const result = resolveEffectiveActionPolicy(baseProfile({ actionPolicy: ap }));
    expect(result).toBe(ap);
  });

  it('appends deploy to enabledGroups when deployment is enabled', () => {
    const ap = policy({ enabledGroups: ['github-prs', 'azure-pim'] });
    const result = resolveEffectiveActionPolicy(
      baseProfile({ actionPolicy: ap, deployment: { enabled: true, env: {} } }),
    );
    expect(result?.enabledGroups).toEqual(['github-prs', 'azure-pim', 'deploy']);
    expect(result?.sanitization).toEqual(ap.sanitization);
    expect(result).not.toBe(ap);
  });

  it('does not duplicate deploy when already in enabledGroups', () => {
    const ap = policy({ enabledGroups: ['deploy', 'github-prs'] });
    const result = resolveEffectiveActionPolicy(
      baseProfile({ actionPolicy: ap, deployment: { enabled: true, env: {} } }),
    );
    expect(result).toBe(ap);
    expect(result?.enabledGroups).toEqual(['deploy', 'github-prs']);
  });

  it('preserves enabledActions, overrides, custom actions, quarantine when augmenting', () => {
    const ap = policy({
      enabledGroups: ['github-prs'],
      enabledActions: ['some_action'],
      actionOverrides: [{ action: 'foo', requiresApproval: true }],
      customActions: [],
      quarantine: { enabled: true, threshold: 0.5, blockThreshold: 0.8, onBlock: 'ask_human' },
    });
    const result = resolveEffectiveActionPolicy(
      baseProfile({ actionPolicy: ap, deployment: { enabled: true, env: {} } }),
    );
    expect(result?.enabledActions).toEqual(['some_action']);
    expect(result?.actionOverrides).toEqual(ap.actionOverrides);
    expect(result?.quarantine).toEqual(ap.quarantine);
  });
});
