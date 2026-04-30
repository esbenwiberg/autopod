import type { Profile } from '@autopod/shared';
import { describe, expect, it } from 'vitest';
import { getAutoAttachedSidecars, resolveSidecarSpec, sidecarPodEnv } from './sidecar-resolver.js';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  // Minimal Profile — only fields accessed by the resolver matter.
  return {
    name: 'test',
    sidecars: null,
    trustedSource: null,
    ...overrides,
  } as unknown as Profile;
}

describe('resolveSidecarSpec', () => {
  it('returns null when the profile has no sidecar config', () => {
    expect(resolveSidecarSpec(makeProfile(), 'dagger')).toBeNull();
  });

  it('returns null when the Dagger config exists but is disabled', () => {
    const profile = makeProfile({
      sidecars: {
        dagger: {
          enabled: false,
          engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
          engineVersion: 'v0.12.0',
        },
      },
    });
    expect(resolveSidecarSpec(profile, 'dagger')).toBeNull();
  });

  it('returns null for an unknown sidecar name', () => {
    const profile = makeProfile({
      sidecars: {
        dagger: {
          enabled: true,
          engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
          engineVersion: 'v0.12.0',
        },
      },
    });
    expect(resolveSidecarSpec(profile, 'postgres')).toBeNull();
  });

  it('produces a privileged SidecarSpec for an enabled Dagger config', () => {
    const profile = makeProfile({
      sidecars: {
        dagger: {
          enabled: true,
          engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
          engineVersion: 'v0.12.0',
        },
      },
    });
    const spec = resolveSidecarSpec(profile, 'dagger');
    expect(spec).not.toBeNull();
    expect(spec?.type).toBe('dagger-engine');
    expect(spec?.name).toBe('dagger');
    expect(spec?.privileged).toBe(true);
    expect(spec?.healthCheck.port).toBe(8080); // default Dagger engine port
    expect(spec?.resources.memoryMb).toBe(2048); // default 2GB
  });

  it('honours custom port, memory, cpu, and storage overrides', () => {
    const profile = makeProfile({
      sidecars: {
        dagger: {
          enabled: true,
          engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
          engineVersion: 'v0.12.0',
          enginePort: 9000,
          memoryGb: 4,
          cpus: 2,
          storageGb: 20,
        },
      },
    });
    const spec = resolveSidecarSpec(profile, 'dagger');
    expect(spec?.healthCheck.port).toBe(9000);
    expect(spec?.resources.memoryMb).toBe(4096);
    expect(spec?.resources.cpus).toBe(2);
    expect(spec?.resources.storageMb).toBe(20_480);
  });
});

describe('getAutoAttachedSidecars', () => {
  it('returns empty when the profile has no sidecar config', () => {
    expect(getAutoAttachedSidecars(makeProfile())).toEqual([]);
  });

  it('returns empty when Dagger is configured but disabled', () => {
    const profile = makeProfile({
      trustedSource: true,
      sidecars: {
        dagger: {
          enabled: false,
          engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
          engineVersion: 'v0.12.0',
        },
      },
    });
    expect(getAutoAttachedSidecars(profile)).toEqual([]);
  });

  it('returns empty when Dagger is enabled but the profile is untrusted', () => {
    const profile = makeProfile({
      trustedSource: false,
      sidecars: {
        dagger: {
          enabled: true,
          engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
          engineVersion: 'v0.12.0',
        },
      },
    });
    expect(getAutoAttachedSidecars(profile)).toEqual([]);
  });

  it('auto-attaches Dagger when enabled on a trusted profile', () => {
    const profile = makeProfile({
      trustedSource: true,
      sidecars: {
        dagger: {
          enabled: true,
          engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
          engineVersion: 'v0.12.0',
        },
      },
    });
    expect(getAutoAttachedSidecars(profile)).toEqual(['dagger']);
  });
});

describe('sidecarPodEnv', () => {
  it('injects _EXPERIMENTAL_DAGGER_RUNNER_HOST for a Dagger engine sidecar', () => {
    const profile = makeProfile({
      sidecars: {
        dagger: {
          enabled: true,
          engineImageDigest: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
          engineVersion: 'v0.12.0',
        },
      },
    });
    const spec = resolveSidecarSpec(profile, 'dagger');
    if (!spec) throw new Error('expected spec');
    expect(sidecarPodEnv(spec)).toEqual({
      _EXPERIMENTAL_DAGGER_RUNNER_HOST: 'tcp://dagger:8080',
    });
  });
});
