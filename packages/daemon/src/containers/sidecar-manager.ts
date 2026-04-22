import { setTimeout as sleep } from 'node:timers/promises';
import {
  SIDECAR_CONTAINER_LABEL,
  SIDECAR_LABEL_NAME,
  SIDECAR_LABEL_POD_ID,
  SIDECAR_LABEL_TYPE,
  type SidecarSpec,
} from '@autopod/shared';
import Dockerode from 'dockerode';
import type { Logger } from 'pino';
import {
  alignMemoryToPageSize,
  createContainerWithStaleRetry,
  isExpectedDockerError,
} from './docker-helpers.js';

/** Floor on health-probe interval — 250ms is tight enough to feel instant
 *  for an engine that came up quickly, but loose enough that a misconfigured
 *  `intervalMs: 10` can't flood the Docker API. */
const MIN_PROBE_INTERVAL_MS = 250;

export interface SpawnSidecarOptions {
  spec: SidecarSpec;
  podId: string;
  /**
   * Docker network the sidecar joins. Must be the same isolated network as the
   * owning pod so that the pod can reach the sidecar by DNS (`spec.name`) but
   * neither has extra egress.
   */
  networkName: string;
}

export interface SidecarHandle {
  containerId: string;
  /** Same as spec.name — the DNS name the pod reaches the sidecar on. */
  name: string;
}

export interface SidecarManager {
  spawn(options: SpawnSidecarOptions): Promise<SidecarHandle>;
  waitHealthy(handle: SidecarHandle, spec: SidecarSpec): Promise<void>;
  kill(containerId: string): Promise<void>;
  /**
   * Find sidecars that outlived their owning pod (crash recovery) and kill them.
   * Returns the number of orphans reaped.
   */
  reconcileOrphans(activePodIds: Set<string>): Promise<number>;
}

interface DockerSidecarManagerOptions {
  docker?: Dockerode;
  logger: Logger;
}

export class DockerSidecarManager implements SidecarManager {
  private docker: Dockerode;
  private logger: Logger;

  constructor({ docker, logger }: DockerSidecarManagerOptions) {
    this.docker = docker ?? new Dockerode();
    this.logger = logger;
  }

  async spawn(options: SpawnSidecarOptions): Promise<SidecarHandle> {
    const { spec, podId, networkName } = options;
    const containerName = buildSidecarName(podId, spec.name);

    await this.ensureImagePresent(spec.image);
    const env = spec.env ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : undefined;

    const hostConfig: Record<string, unknown> = {
      NetworkMode: networkName,
      AutoRemove: false,
      Memory: alignMemoryToPageSize(spec.resources.memoryMb * 1024 * 1024),
      NanoCpus: Math.floor(spec.resources.cpus * 1e9),
      PidsLimit: spec.resources.pidsLimit,
      Privileged: spec.privileged === true,
      CapAdd: spec.capabilities && spec.capabilities.length > 0 ? spec.capabilities : undefined,
    };
    if (spec.resources.storageMb) {
      // StorageOpt only works on storage drivers that support it (overlay2 + xfs
      // project quotas). On the common macOS Desktop driver it's a no-op; on
      // Linux it caps the writable layer.
      hostConfig.StorageOpt = { size: `${spec.resources.storageMb}M` };
    }

    const labels = {
      [SIDECAR_CONTAINER_LABEL]: 'true',
      [SIDECAR_LABEL_POD_ID]: podId,
      [SIDECAR_LABEL_NAME]: spec.name,
      [SIDECAR_LABEL_TYPE]: spec.type,
    };

    const networkingConfig: Dockerode.ContainerCreateOptions['NetworkingConfig'] = {
      EndpointsConfig: {
        [networkName]: {
          Aliases: [spec.name],
        },
      },
    };

    this.logger.info(
      {
        podId,
        sidecarName: spec.name,
        sidecarType: spec.type,
        image: spec.image,
        privileged: hostConfig.Privileged,
      },
      'Spawning sidecar',
    );

    const container = await createContainerWithStaleRetry(
      this.docker,
      {
        Image: spec.image,
        name: containerName,
        Env: env,
        Labels: labels,
        ExposedPorts: { [`${spec.healthCheck.port}/tcp`]: {} },
        HostConfig: hostConfig,
        NetworkingConfig: networkingConfig,
      },
      this.logger,
    );

    await container.start();

    this.logger.info(
      { containerId: container.id, containerName, podId, sidecarName: spec.name },
      'Sidecar started',
    );

    return { containerId: container.id, name: spec.name };
  }

  async waitHealthy(handle: SidecarHandle, spec: SidecarSpec): Promise<void> {
    const deadline = Date.now() + spec.healthCheck.timeoutMs;
    const interval = Math.max(MIN_PROBE_INTERVAL_MS, spec.healthCheck.intervalMs);

    while (Date.now() < deadline) {
      const healthy = await this.probeOnce(handle);
      if (healthy) {
        this.logger.debug(
          { containerId: handle.containerId, sidecarName: handle.name },
          'Sidecar healthy',
        );
        return;
      }
      await sleep(interval);
    }

    throw new SidecarHealthTimeoutError(handle, spec);
  }

  async kill(containerId: string): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      try {
        await container.stop({ t: 10 });
      } catch (err: unknown) {
        if (!isExpectedDockerError(err, [304, 404])) throw err;
      }
      try {
        await container.remove({ force: true });
      } catch (err: unknown) {
        if (!isExpectedDockerError(err, [404])) throw err;
      }
      this.logger.info({ containerId }, 'Sidecar killed');
    } catch (err: unknown) {
      if (isExpectedDockerError(err, [404])) {
        this.logger.debug({ containerId }, 'Sidecar already gone');
        return;
      }
      this.logger.error({ containerId, err }, 'Failed to kill sidecar');
      throw err;
    }
  }

  async reconcileOrphans(activePodIds: Set<string>): Promise<number> {
    const filters = {
      label: [`${SIDECAR_CONTAINER_LABEL}=true`],
    };
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify(filters),
    });

    const orphans = containers.filter((info) => {
      const podId = info.Labels?.[SIDECAR_LABEL_POD_ID];
      return podId && !activePodIds.has(podId);
    });

    // Parallel kill — each kill is independent I/O and we want startup recovery
    // to complete fast even with many orphans. Docker API handles concurrent
    // requests fine.
    const results = await Promise.allSettled(
      orphans.map((info) => {
        this.logger.warn(
          {
            containerId: info.Id,
            podId: info.Labels?.[SIDECAR_LABEL_POD_ID],
            sidecarName: info.Labels?.[SIDECAR_LABEL_NAME],
          },
          'Reaping orphan sidecar',
        );
        return this.kill(info.Id);
      }),
    );

    let reaped = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const orphan = orphans[i];
      if (!result || !orphan) continue;
      if (result.status === 'fulfilled') {
        reaped++;
      } else {
        this.logger.error(
          {
            containerId: orphan.Id,
            podId: orphan.Labels?.[SIDECAR_LABEL_POD_ID],
            err: result.reason,
          },
          'Failed to reap orphan sidecar',
        );
      }
    }
    return reaped;
  }

  /**
   * Ensure the sidecar image is locally cached. `createContainer` does not
   * auto-pull — a first-ever sidecar spawn on a fresh daemon would otherwise
   * 404. Idempotent: if the image is already present, `pull` returns quickly.
   */
  private async ensureImagePresent(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (err: unknown) {
      if (!isExpectedDockerError(err, [404])) throw err;
    }
    this.logger.info({ image }, 'Pulling sidecar image');
    const stream = (await this.docker.pull(image)) as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (followErr: Error | null) => (followErr ? reject(followErr) : resolve()),
        () => {},
      );
    });
  }

  /**
   * v1: container-state probe only. Returns true once the container is running
   * and hasn't exited with a non-zero code. Real TCP/HTTP port probes require
   * executing in the sidecar's network namespace (exec `nc -z` / `wget --spider`
   * from a neighbour container) — deferred until we hit a case where
   * "running != ready" causes actual test flakiness.
   */
  private async probeOnce(handle: SidecarHandle): Promise<boolean> {
    try {
      const container = this.docker.getContainer(handle.containerId);
      const info = await container.inspect();
      if (!info.State.Running) return false;
      if (info.State.ExitCode && info.State.ExitCode !== 0) return false;
      return true;
    } catch {
      return false;
    }
  }
}

export class SidecarHealthTimeoutError extends Error {
  constructor(
    public handle: SidecarHandle,
    public spec: SidecarSpec,
  ) {
    super(
      `Sidecar ${handle.name} (type=${spec.type}) did not become healthy within ${spec.healthCheck.timeoutMs}ms`,
    );
    this.name = 'SidecarHealthTimeoutError';
  }
}

/**
 * Build a deterministic container name. `autopod-<podId>-<sidecarName>`
 * ensures uniqueness without collisions against the main pod container
 * (`autopod-<podId>`).
 */
export function buildSidecarName(podId: string, sidecarName: string): string {
  return `autopod-${podId}-${sidecarName}`;
}
