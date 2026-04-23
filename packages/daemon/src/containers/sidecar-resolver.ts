import {
  DAGGER_RUNNER_HOST_ENV,
  DEFAULT_DAGGER_ENGINE_PORT,
  type DaggerSidecarConfig,
  type Profile,
  type SidecarSpec,
} from '@autopod/shared';

/**
 * Resolve a per-pod sidecar name (e.g. `'dagger'`) into a concrete
 * `SidecarSpec` by looking it up in the pod's profile. Returns `null` when
 * the profile has no config for that name, or the config exists but is
 * disabled.
 *
 * New sidecar types (postgres, redis, ...) are added by extending this
 * function — the SidecarManager orchestration layer stays generic.
 */
export function resolveSidecarSpec(profile: Profile, name: string): SidecarSpec | null {
  if (name === 'dagger') {
    const cfg = profile.sidecars?.dagger;
    if (!cfg || !cfg.enabled) return null;
    return buildDaggerSidecarSpec(cfg);
  }
  return null;
}

/**
 * Environment variables the POD container needs so its tools can reach the
 * sidecar. E.g. the Dagger CLI reads `_EXPERIMENTAL_DAGGER_RUNNER_HOST` to
 * find a remote engine.
 */
export function sidecarPodEnv(spec: SidecarSpec): Record<string, string> {
  if (spec.type === 'dagger-engine') {
    return {
      [DAGGER_RUNNER_HOST_ENV]: `tcp://${spec.name}:${spec.healthCheck.port}`,
    };
  }
  return {};
}

function buildDaggerSidecarSpec(cfg: DaggerSidecarConfig): SidecarSpec {
  const port = cfg.enginePort ?? DEFAULT_DAGGER_ENGINE_PORT;
  return {
    type: 'dagger-engine',
    name: 'dagger',
    image: cfg.engineImageDigest,
    healthCheck: {
      port,
      // Engine pulls BuildKit layers + starts up; 90s covers cold-pull worst case.
      timeoutMs: 90_000,
      intervalMs: 500,
    },
    resources: {
      memoryMb: (cfg.memoryGb ?? 2) * 1024,
      cpus: cfg.cpus ?? 1,
      pidsLimit: 4096,
      storageMb: (cfg.storageGb ?? 10) * 1024,
    },
    // BuildKit requires privileged mode for its OCI runtime + overlay mounts.
    privileged: true,
    // By default dagger-entrypoint.sh boots the engine with only the unix
    // socket (/run/buildkit/buildkitd.sock). The pod reaches the engine over
    // TCP, so we have to explicitly add a TCP listener. Keeping the unix
    // socket as well means `docker exec dagger-engine dagger` still works
    // for debugging from inside the sidecar.
    command: ['--addr', `tcp://0.0.0.0:${port}`, '--addr', 'unix:///run/buildkit/buildkitd.sock'],
  };
}
