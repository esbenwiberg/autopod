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
   * Look up the sidecar's IP on the given network. Pod-manager uses this
   * after `spawn` + `waitHealthy` to allowlist the IP in the pod container's
   * iptables rules before the pod is spawned on the same network.
   */
  getBridgeIp(handle: SidecarHandle, networkName: string): Promise<string | null>;
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
      // Use the host's cgroup namespace for Dagger / BuildKit engines. In the
      // default 'private' cgroupns, the image's entrypoint tries to enable
      // controllers on its own cgroup root, which intermittently fails with
      // EBUSY on Docker Desktop (especially when many privileged containers
      // are already running), surfacing as `sed: write error` + exit 4 within
      // ~100ms of start. Dagger's upstream docker-compose recipe uses
      // `cgroup: host` for the same reason. Only applies to privileged
      // sidecars — non-privileged ones don't touch cgroup controllers.
      ...(spec.privileged === true ? { CgroupnsMode: 'host' } : {}),
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
        // Pass spec.command as Cmd — it's appended to the image's Entrypoint.
        // For dagger-engine this is `--addr tcp://0.0.0.0:8080 ...`, without
        // which the engine listens on a unix socket only and the pod can't
        // reach it over the network.
        Cmd: spec.command && spec.command.length > 0 ? spec.command : undefined,
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
      const healthy = await this.probeOnce(handle, spec);
      if (healthy) {
        this.logger.debug(
          {
            containerId: handle.containerId,
            sidecarName: handle.name,
            port: spec.healthCheck.port,
          },
          'Sidecar healthy',
        );
        return;
      }
      // Fast-exit the health-check loop if the container has died. Without
      // this, a sidecar whose entrypoint crashes immediately (e.g. dagger
      // engine hitting EBUSY in its cgroup setup) forces the caller to wait
      // out the full 90s timeout before surfacing the failure. Grab the
      // crash state + last logs and throw early with actionable context.
      const crashInfo = await this.containerCrashDetails(handle);
      if (crashInfo) {
        this.logger.error(
          {
            containerId: handle.containerId,
            sidecarName: handle.name,
            exitCode: crashInfo.exitCode,
            startedAt: crashInfo.startedAt,
            finishedAt: crashInfo.finishedAt,
            lastLogs: crashInfo.logs,
          },
          'Sidecar exited before becoming healthy',
        );
        throw new SidecarHealthTimeoutError(handle, spec, crashInfo);
      }
      await sleep(interval);
    }

    const crashInfo = await this.containerCrashDetails(handle);
    if (crashInfo) {
      this.logger.error(
        {
          containerId: handle.containerId,
          sidecarName: handle.name,
          exitCode: crashInfo.exitCode,
          lastLogs: crashInfo.logs,
        },
        'Sidecar never became healthy within timeout (and has since exited)',
      );
    }
    throw new SidecarHealthTimeoutError(handle, spec, crashInfo ?? undefined);
  }

  /**
   * If the sidecar has exited, return its exit code + last lines of stdout/stderr.
   * Returns `null` while the container is still running so callers keep probing.
   */
  private async containerCrashDetails(
    handle: SidecarHandle,
  ): Promise<{ exitCode: number; startedAt: string; finishedAt: string; logs: string } | null> {
    try {
      const container = this.docker.getContainer(handle.containerId);
      const info = await container.inspect();
      if (info.State.Running) return null;
      const logs = (await container.logs({ stdout: true, stderr: true, tail: 40 })).toString();
      return {
        exitCode: info.State.ExitCode ?? -1,
        startedAt: info.State.StartedAt ?? '',
        finishedAt: info.State.FinishedAt ?? '',
        logs: logs.slice(-2000),
      };
    } catch {
      return null;
    }
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
   * Two-phase probe:
   *  1. Container must be running and not crashed.
   *  2. The expected TCP port must actually be listening inside the container.
   *     We read `/proc/net/tcp` + `/proc/net/tcp6` and look for a LISTEN-state
   *     socket on the port (formatted as hex, matching how the kernel exposes
   *     it). This is tool-free (no nc / netcat / curl required), so it works
   *     across sidecar images regardless of what's installed.
   *
   * Without phase 2, a sidecar whose binary crashes during startup or whose
   * default config binds only to a unix socket would report as healthy, and
   * the pod would start believing the sidecar is reachable — exactly what
   * happened with the dagger-engine default-config bug. Hence this probe is
   * required, not optional.
   */
  private async probeOnce(handle: SidecarHandle, spec: SidecarSpec): Promise<boolean> {
    try {
      const container = this.docker.getContainer(handle.containerId);
      const info = await container.inspect();
      if (!info.State.Running) return false;
      if (info.State.ExitCode && info.State.ExitCode !== 0) return false;

      return await this.probeTcpListening(container, spec.healthCheck.port);
    } catch {
      return false;
    }
  }

  /**
   * Exec into the sidecar container and check whether a LISTEN-state socket
   * is bound to `port`. `/proc/net/tcp` column 2 is `local_address:PORT` with
   * the port in uppercase hex (e.g. 8080 → `1F90`); column 4 is the TCP state
   * (`0A` is LISTEN). We match both IPv4 and IPv6 (`/proc/net/tcp6`) so the
   * probe works whether the listener bound to `0.0.0.0`, `::`, or both.
   */
  private async probeTcpListening(container: Dockerode.Container, port: number): Promise<boolean> {
    const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
    // awk: if local_address ends with ":HEXPORT" and state is 0A (LISTEN), exit 0.
    const script = `awk 'NR>1 { split($2, a, ":"); if (toupper(a[2]) == "${hexPort}" && $4 == "0A") { found=1 } } END { exit (found ? 0 : 1) }' /proc/net/tcp /proc/net/tcp6 2>/dev/null`;

    // AttachStdout/Stderr must both be true. With them false, Dockerode's
    // exec.start() stream emits 'end' immediately (nothing attached = nothing
    // to stream), and a subsequent inspect() returns Running:true ExitCode:null
    // because the awk hasn't actually finished yet. The probe then misreads
    // "null !== 0" as "port isn't listening" and falls into a 90s timeout loop.
    // Attaching ties stream-end to process-exit, so the drain below is correct.
    const exec = await container.exec({
      Cmd: ['sh', '-c', script],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.on('end', () => resolve());
      stream.on('error', () => resolve());
      stream.resume();
    });
    // Belt-and-braces: poll inspect a few times in case stream-end races the
    // ExitCode field being populated on Docker's side.
    for (let i = 0; i < 10; i++) {
      const info = await exec.inspect();
      if (!info.Running) return info.ExitCode === 0;
      await sleep(20);
    }
    return false;
  }

  /**
   * Resolve the sidecar's IP on the given network. Used by the pod-side
   * firewall to allowlist intra-bridge traffic to the sidecar before the
   * pod container is spawned with its restrictive iptables rules.
   */
  async getBridgeIp(handle: SidecarHandle, networkName: string): Promise<string | null> {
    try {
      const container = this.docker.getContainer(handle.containerId);
      const info = await container.inspect();
      const networks = info.NetworkSettings?.Networks;
      const net = networks?.[networkName];
      return net?.IPAddress || null;
    } catch {
      return null;
    }
  }
}

export class SidecarHealthTimeoutError extends Error {
  constructor(
    public handle: SidecarHandle,
    public spec: SidecarSpec,
    public crashInfo?: { exitCode: number; logs: string; finishedAt: string },
  ) {
    const base = crashInfo
      ? `Sidecar ${handle.name} (type=${spec.type}) exited with code ${crashInfo.exitCode} before becoming healthy`
      : `Sidecar ${handle.name} (type=${spec.type}) did not become healthy within ${spec.healthCheck.timeoutMs}ms`;
    const tail = crashInfo ? `\nLast container logs:\n${crashInfo.logs}` : '';
    super(base + tail);
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
