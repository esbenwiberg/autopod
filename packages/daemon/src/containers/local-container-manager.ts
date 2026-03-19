import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecResult,
  ExecOptions,
} from '../interfaces/container-manager.js';

const execFileAsync = promisify(execFile);

/**
 * Filesystem passthrough "container" manager for local-first execution.
 *
 * The "container" IS the worktree directory. Maps `/workspace/` prefix
 * in container paths to the real worktree path on disk.
 */
export class LocalContainerManager implements ContainerManager {
  /** Maps containerId → workspace path on disk. */
  private workspaces = new Map<string, string>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async spawn(config: ContainerSpawnConfig): Promise<string> {
    const containerId = `local-${config.sessionId}`;

    // Extract workspace path from volumes config
    const workspaceVolume = config.volumes?.find(v => v.container === '/workspace');
    const workspacePath = workspaceVolume?.host;

    if (!workspacePath) {
      this.logger.warn({
        containerId,
        msg: 'No /workspace volume found in spawn config, container will have limited functionality',
      });
    }

    if (workspacePath) {
      this.workspaces.set(containerId, workspacePath);
    }

    this.logger.info({ containerId, workspacePath }, 'Local container spawned');
    return containerId;
  }

  async kill(containerId: string): Promise<void> {
    this.workspaces.delete(containerId);
    this.logger.info({ containerId }, 'Local container killed');
  }

  async writeFile(containerId: string, filePath: string, content: string): Promise<void> {
    const resolvedPath = this.resolvePath(containerId, filePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, content, 'utf-8');
  }

  async getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'> {
    return this.workspaces.has(containerId) ? 'running' : 'stopped';
  }

  async execInContainer(
    containerId: string,
    command: string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const workspacePath = this.workspaces.get(containerId);
    const cwd = options?.cwd
      ? this.resolveContainerPath(workspacePath, options.cwd)
      : workspacePath;

    const [cmd, ...args] = command;
    if (!cmd) {
      return { stdout: '', stderr: 'No command specified', exitCode: 1 };
    }

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: cwd ?? undefined,
        timeout: options?.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: execErr.stdout ?? '',
        stderr: execErr.stderr ?? (err instanceof Error ? err.message : String(err)),
        exitCode: execErr.code ?? 1,
      };
    }
  }

  // --- Private helpers ---

  /**
   * Resolve a container path (e.g. `/workspace/src/foo.ts`) to a real filesystem path.
   */
  private resolvePath(containerId: string, containerPath: string): string {
    const workspacePath = this.workspaces.get(containerId);
    if (!workspacePath) {
      throw new Error(`Container ${containerId} not found or has no workspace`);
    }
    return this.resolveContainerPath(workspacePath, containerPath);
  }

  private resolveContainerPath(workspacePath: string | undefined, containerPath: string): string {
    if (!workspacePath) return containerPath;

    // Map /workspace/X → workspacePath/X
    if (containerPath.startsWith('/workspace/')) {
      return path.join(workspacePath, containerPath.slice('/workspace/'.length));
    }
    if (containerPath === '/workspace') {
      return workspacePath;
    }

    // Non-workspace paths pass through as-is
    return containerPath;
  }
}
