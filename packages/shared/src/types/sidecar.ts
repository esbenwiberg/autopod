/**
 * Sidecar — a companion container spawned alongside a pod.
 *
 * The generic abstraction: any workload that needs a neighbouring container
 * on the pod's isolated Docker network (e.g. a Dagger engine, an ephemeral
 * Postgres for integration tests, Azurite for Azure-storage emulation).
 *
 * v1 only implements `dagger-engine`. New types are added by extending the
 * union and wiring a handler in the daemon's SidecarManager.
 */

export type SidecarType = 'dagger-engine';

export interface SidecarHealthCheck {
  /** TCP port exposed by the sidecar to the pod's network. */
  port: number;
  /** HTTP path for health probes. If omitted, TCP-connect only. */
  path?: string;
  /** Total time the daemon will wait before marking the sidecar unhealthy. */
  timeoutMs: number;
  /** Probe interval. */
  intervalMs: number;
}

export interface SidecarResources {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  /** Optional writable-layer size cap. Only enforced on storage drivers that support it. */
  storageMb?: number;
}

/**
 * Generic spec for spawning a sidecar. Resolved by the daemon at pod-creation
 * time from profile-level typed configs (e.g. `profile.sidecars.dagger`).
 */
export interface SidecarSpec {
  type: SidecarType;
  /** DNS name reachable from the pod on its network (e.g. 'dagger'). */
  name: string;
  /** Fully qualified image reference pinned by digest, e.g. `registry.dagger.io/engine@sha256:...`. */
  image: string;
  env?: Record<string, string>;
  healthCheck: SidecarHealthCheck;
  resources: SidecarResources;
  /** Privileged mode — required for Dagger/BuildKit. Default false. */
  privileged?: boolean;
  /** Extra Linux capabilities. Additive to the non-privileged defaults. */
  capabilities?: string[];
}

/**
 * Per-type configuration lives on the profile under `profile.sidecars`. Each
 * concrete type has its own config object so we keep typed validation at the
 * edges instead of stuffing everything into one `SidecarSpec[]`.
 */
export interface DaggerSidecarConfig {
  enabled: boolean;
  /**
   * Engine image pinned by SHA256 digest, e.g.
   *   'registry.dagger.io/engine@sha256:abc...'
   * Updates should land in code via PR review, not rolling tags.
   */
  engineImageDigest: string;
  /** Human-readable version label for audit logs. */
  engineVersion: string;
  /** Engine TCP port exposed to the pod. Defaults to 8080. */
  enginePort?: number;
  /** Engine memory cap in GB. Default 2. */
  memoryGb?: number;
  /** Engine CPU cap. Default 1. */
  cpus?: number;
  /** BuildKit cache / writable-layer cap in GB. Default 10. */
  storageGb?: number;
}

/**
 * Root profile-level sidecar config. Each field is an optional per-type
 * config; future types (postgres, redis, azurite, ...) add sibling fields.
 */
export interface SidecarsConfig {
  dagger?: DaggerSidecarConfig;
}

/** Default engine TCP port (Dagger engine listens on 8080 by convention). */
export const DEFAULT_DAGGER_ENGINE_PORT = 8080;

/** Environment variable Dagger CLI reads to locate a remote engine. */
export const DAGGER_RUNNER_HOST_ENV = '_EXPERIMENTAL_DAGGER_RUNNER_HOST';

/** Docker label keys used for sidecar orphan reconciliation. */
export const SIDECAR_LABEL_POD_ID = 'com.autopod.pod-id';
export const SIDECAR_LABEL_NAME = 'com.autopod.sidecar-name';
export const SIDECAR_LABEL_TYPE = 'com.autopod.sidecar-type';
export const SIDECAR_CONTAINER_LABEL = 'com.autopod.is-sidecar';
