import { describe, expect, it } from 'vitest';
import { formatPodProfile } from './pod-profile.js';

describe('profile presentation', () => {
  it('uses captured names without losing the raw identity', () => {
    const pod = {
      profileName: 'uuid',
      profileDisplay: { id: 'uuid', name: 'Works Claude', state: 'active' as const },
    };
    expect(formatPodProfile(pod)).toBe('Works Claude');
    expect(pod.profileName).toBe('uuid');
  });
  it.each(['archived', 'deleted'] as const)('explains %s profiles', (state) => {
    expect(
      formatPodProfile({
        profileName: 'uuid',
        profileDisplay: { id: 'uuid', name: 'Works Claude', state },
      }),
    ).toBe(`Works Claude (${state})`);
  });
  it('keeps missing snapshot metadata explicit and supports older daemons', () => {
    expect(
      formatPodProfile({
        profileName: 'uuid',
        profileDisplay: { id: 'uuid', name: null, state: 'unavailable' },
      }),
    ).toBe('Unavailable profile');
    expect(formatPodProfile({ profileName: 'legacy-app' })).toBe('legacy-app');
  });
});
