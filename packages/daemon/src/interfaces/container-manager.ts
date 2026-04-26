import type { Readable } from 'node:stream';

export interface ContainerSpawnConfig {
  image: string;
  podId: string;
  env: Record<string, string>;
  ports?: { container: number; host: number }[];
  volumes?: { host: string; container: string }[];
  /** Docker network name for network isolation */
  networkName?: string;
  /** Firewall script to execute after container start (iptables rules) */
  firewallScript?: string;
  /**
   * Network policy mode — controls fail-closed behaviour on firewall errors.
   * When AUTOPOD_FAIL_CLOSED_FIREWALL=1, spawn is aborted for deny-all and
   * restricted pods if the firewall script fails; allow-all pods still start.
   */
  networkPolicyMode?: 'allow-all' | 'deny-all' | 'restricted';
  /** Hard memory limit in bytes. Omit for no limit. */
  memoryBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  /** Run the command as this user inside the container (e.g. 'root'). */
  user?: string;
  /**
   * Extra env vars to set on the exec'd process (in addition to the container's
   * main-process env). Used to inject per-call secrets like the NuGet credential
   * provider's VSS_NUGET_EXTERNAL_FEED_ENDPOINTS without baking them into the
   * container's creation env (which would expose them via `docker inspect`).
   */
  env?: Record<string, string>;
}

export interface StreamingExecResult {
  stdout: Readable;
  stderr: Readable;
  exitCode: Promise<number>;
  kill(): Promise<void>;
}

export interface ContainerManager {
  spawn(config: ContainerSpawnConfig): Promise<string>; // returns containerId
  kill(containerId: string): Promise<void>;
  /** Re-apply firewall rules to a running container (live policy update). Idempotent — flushes and re-applies. */
  refreshFirewall(containerId: string, script: string): Promise<void>;
  /** Stop a container without removing it. Idempotent — swallows "already stopped". */
  stop(containerId: string): Promise<void>;
  /** Start a previously stopped container. Idempotent — swallows "already running". */
  start(containerId: string): Promise<void>;
  writeFile(containerId: string, path: string, content: string | Buffer): Promise<void>;
  readFile(containerId: string, path: string): Promise<string>;
  /**
   * Extract a directory from a container (works on stopped containers) to a host path.
   * Clears the host directory contents first (skipping any entries in `excludes`),
   * then extracts the container directory (skipping entries matching `excludes`).
   * `excludes` entries are matched against the top-level names within containerPath.
   */
  extractDirectoryFromContainer(
    containerId: string,
    containerPath: string,
    hostPath: string,
    excludes?: string[],
  ): Promise<void>;
  getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'>;
  execInContainer(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  execStreaming(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<StreamingExecResult>;
}
