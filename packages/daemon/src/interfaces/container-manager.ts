import type { Readable } from 'node:stream';

export interface TtyExecResult {
  /** Raw output stream (stdout+stderr merged via TTY) */
  output: Readable;
  /** Write data to container stdin */
  write(data: Buffer | string): void;
  /** Resize the terminal */
  resize(cols: number, rows: number): Promise<void>;
  /** Terminate the exec session */
  kill(): Promise<void>;
  /** Resolves with the exit code when the process ends */
  exitCode: Promise<number>;
}

export interface ContainerSpawnConfig {
  image: string;
  sessionId: string;
  env: Record<string, string>;
  ports?: { container: number; host: number }[];
  volumes?: { host: string; container: string }[];
  /** Docker network name for network isolation */
  networkName?: string;
  /** Firewall script to execute after container start (iptables rules) */
  firewallScript?: string;
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
  writeFile(containerId: string, path: string, content: string): Promise<void>;
  readFile(containerId: string, path: string): Promise<string>;
  getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'>;
  execInContainer(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult>;
  execStreaming(
    containerId: string,
    command: string[],
    options?: ExecOptions & { env?: Record<string, string> },
  ): Promise<StreamingExecResult>;
  /** Open an interactive TTY shell in the container (stdin + stdout+stderr merged). */
  execTty(
    containerId: string,
    command: string[],
    options?: { cols?: number; rows?: number },
  ): Promise<TtyExecResult>;
}
