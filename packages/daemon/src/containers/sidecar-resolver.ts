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
 * Sidecar names that are auto-attached to every pod on the profile when their
 * config is enabled. Adding a name here means "if the profile turns this on,
 * every pod gets it" — the per-pod `requireSidecars` flag becomes additive
 * instead of mandatory. Privileged auto-attach still respects `trustedSource`,
 * so untrusted profiles silently skip even with `enabled: true`.
 */
const AUTO_ATTACH_SIDECAR_NAMES: readonly string[] = ['dagger'];

/**
 * Names of sidecars the daemon will spawn automatically for any pod created
 * against this profile, given the profile's current config + trust gate.
 *
 * Returned names are guaranteed to resolve to a non-null `SidecarSpec` and
 * pass the privileged-trust check, so feeding them straight back into the
 * pod's `requireSidecars` array won't trip the validation in `createSession`.
 *
 * Sub-profiles can opt out by setting `sidecars.dagger.enabled: false` (simple
 * inheritance override) or `trustedSource: false` (kills privileged
 * auto-attach for the whole profile).
 */
export function getAutoAttachedSidecars(profile: Profile): string[] {
  const names: string[] = [];
  for (const name of AUTO_ATTACH_SIDECAR_NAMES) {
    const spec = resolveSidecarSpec(profile, name);
    if (!spec) continue;
    if (spec.privileged === true && profile.trustedSource !== true) continue;
    names.push(name);
  }
  return names;
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
