import type { ExecutionTarget } from '@autopod/shared';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecOptions,
} from '../interfaces/container-manager.js';

export interface RoutingContainerManagerOptions {
  local: ContainerManager;
  sandbox?: ContainerManager;
  resolveTarget(containerId: string): ExecutionTarget | null | undefined;
}

export class RoutingContainerManager implements ContainerManager {
  private readonly local: ContainerManager;
  private readonly sandbox?: ContainerManager;
  private readonly resolveTarget: RoutingContainerManagerOptions['resolveTarget'];

  constructor(options: RoutingContainerManagerOptions) {
    this.local = options.local;
    this.sandbox = options.sandbox;
    this.resolveTarget = options.resolveTarget;
  }

  spawn(config: ContainerSpawnConfig): Promise<string> {
    return this.local.spawn(config);
  }

  kill(containerId: string): Promise<void> {
    return this.delegate(containerId).kill(containerId);
  }

  refreshFirewall(containerId: string, script: string): Promise<void> {
    return this.delegate(containerId).refreshFirewall(containerId, script);
  }

  stop(containerId: string): Promise<void> {
    return this.delegate(containerId).stop(containerId);
  }

  start(containerId: string): Promise<void> {
    return this.delegate(containerId).start(containerId);
  }

  writeFile(containerId: string, path: string, content: string | Buffer): Promise<void> {
    return this.delegate(containerId).writeFile(containerId, path, content);
  }

  readFile(containerId: string, path: string): Promise<string> {
    return this.delegate(containerId).readFile(containerId, path);
  }

  readFileBinary(containerId: string, path: string): Promise<Buffer> {
    return this.delegate(containerId).readFileBinary(containerId, path);
  }

  extractDirectoryFromContainer(
    containerId: string,
    containerPath: string,
    hostPath: string,
    excludes?: string[],
  ): Promise<void> {
    return this.delegate(containerId).extractDirectoryFromContainer(
      containerId,
      containerPath,
      hostPath,
      excludes,
    );
  }

  getStatus(containerId: string): Promise<'running' | 'stopped' | 'unknown'> {
    return this.delegate(containerId).getStatus(containerId);
  }

  execInContainer(containerId: string, command: string[], options?: ExecOptions) {
    return this.delegate(containerId).execInContainer(containerId, command, options);
  }

  execStreaming(containerId: string, command: string[], options?: ExecOptions) {
    return this.delegate(containerId).execStreaming(containerId, command, options);
  }

  private delegate(containerId: string): ContainerManager {
    const target = this.resolveTarget(containerId);
    if (target === 'sandbox' && this.sandbox) return this.sandbox;
    return this.local;
  }
}
