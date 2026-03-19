import type { Readable } from 'node:stream';

export interface ContainerSpawnConfig {
  image: string;
  sessionId: string;
  env: Record<string, string>;
  ports?: { container: number; host: number }[];
  volumes?: { host: string; container: string }[];
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
  writeFile(containerId: string, path: string, content: string): Promise<void>;
  getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'>;
  execInContainer(containerId: string, command: string[], options?: ExecOptions): Promise<ExecResult>;
  execStreaming(
    containerId: string,
    command: string[],
    options?: ExecOptions & { env?: Record<string, string> },
  ): Promise<StreamingExecResult>;
}
