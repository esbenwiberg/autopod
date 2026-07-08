import type { Readable } from 'node:stream';

export interface ContainerSpawnConfig {
  image: string;
  podId: string;
  env: Record<string, string>;
  ports?: { container: number; host: number }[];
  volumes?: { host: string; container: string; readOnly?: boolean }[];
  /** Docker network name for network isolation */
  networkName?: string;
  /** Firewall script to execute after container start (iptables rules) */
  firewallScript?: string;
  /**
   * Network policy mode — controls fail-closed behaviour on firewall errors.
   * For `deny-all` and `restricted` pods, spawn aborts by default if the
   * firewall script fails (the container is force-removed). `allow-all` pods
   * always degrade gracefully. Set `AUTOPOD_FAIL_OPEN_FIREWALL=1` to opt out
   * of fail-closed and allow degraded spawn for isolated pods.
   */
  networkPolicyMode?: 'allow-all' | 'deny-all' | 'restricted';
  /**
   * Allowlisted egress hosts for `restricted` mode. The Docker backend encodes
   * these in `firewallScript` (iptables/HAProxy); the Sandboxes backend consumes
   * them directly to build its native per-sandbox egress policy.
   */
  allowedHosts?: string[];
  /** Hard memory limit in bytes. Omit for no limit. */
  memoryBytes?: number;
  /**
   * Hard CPU limit in NanoCpus (billionths of a core, Docker's `HostConfig.NanoCpus`
   * unit). E.g. `2 * 1e9` caps the container at 2 cores. Omit for no limit.
   */
  nanoCpus?: number;
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

export interface TerminalSessionOptions {
  /** Initial terminal width in columns. */
  cols: number;
  /** Initial terminal height in rows. */
  rows: number;
}

/**
 * An interactive TTY session attached to a running container — the backend for
 * the `WS /pods/:podId/terminal` route (`ap shell` / `ap attach`). TTY output
 * merges stdout and stderr into a single stream, mirroring a real terminal.
 */
export interface TerminalSession {
  /** Subscribe to merged TTY output bytes. */
  onData(listener: (chunk: Buffer) => void): void;
  /** Fired once when the remote shell exits, with its exit code. */
  onExit(listener: (exitCode: number) => void): void;
  /** Fired on a transport-level error. */
  onError(listener: (err: Error) => void): void;
  /** Write raw stdin bytes to the shell. */
  write(data: Buffer): void;
  /** Resize the TTY. Values are clamped by the caller. */
  resize(cols: number, rows: number): void;
  /** Close the session and release the transport. Idempotent. */
  close(): void;
}

export interface ContainerManager {
  /**
   * Whether `execStreaming()` supports long-lived stdout/stderr streams for agent runtimes.
   * Omitted means supported for legacy/test managers; buffered-only managers must set false.
   */
  supportsStreamingExec?: boolean;
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
  /** Read raw bytes from a container path. Same semantics as `readFile` but
   *  returns the file as a Buffer — required for binary files (PNG, PDF, etc.)
   *  that would be corrupted by utf-8 decoding. */
  readFileBinary(containerId: string, path: string): Promise<Buffer>;
  /**
   * Extract a directory from a container (works on stopped containers) to a host path.
   * Clears the host directory contents first (skipping any entries in `excludes`),
   * then extracts the container directory (skipping entries matching `excludes`).
   * Bare `excludes` entries such as `node_modules` match any path segment; entries
   * with slashes match that relative path and its descendants.
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
  /**
   * Attach an interactive TTY session for the terminal route. Optional — a
   * manager without interactive support omits it, and the terminal route rejects
   * the connection. Docker uses a hijacked TTY exec inline in the route; the
   * Sandboxes backend implements this over the exec-stream WebSocket TTY variant.
   */
  attachTerminal?(containerId: string, options: TerminalSessionOptions): Promise<TerminalSession>;
}
