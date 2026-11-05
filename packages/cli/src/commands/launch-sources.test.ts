import type { EffectiveLaunchConfig } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { validateEffectiveLaunchSources, validateLaunchSources } from './launch-sources.js';

describe('launch source selectors', () => {
  it.each(['main', 'feature/prep-work.v2', 'deadbee', '1234', 'a'.repeat(39)])(
    'preserves named branch %s',
    (branch) => {
      expect(() =>
        validateLaunchSources({ startBranch: branch, baseBranch: branch }),
      ).not.toThrow();
    },
  );
  it('preserves omitted selectors', () => {
    expect(() => validateLaunchSources(undefined)).not.toThrow();
    expect(() => validateLaunchSources({})).not.toThrow();
  });
  it('checks the effective repository default without overriding an explicit base', () => {
    const config = {
      work: {},
      repository: { setup: { defaultBranch: 'a'.repeat(40) } },
    } as EffectiveLaunchConfig;
    expect(() => validateEffectiveLaunchSources(config)).toThrow('work.baseBranch');
    config.work = { baseBranch: 'release/v2' };
    expect(() => validateEffectiveLaunchSources(config)).not.toThrow();
  });
});
