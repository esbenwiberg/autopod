import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContainerManager,
  ContainerSpawnConfig,
  ExecOptions,
  ExecResult,
  StreamingExecResult,
} from '../interfaces/container-manager.js';
import { RoutingContainerManager } from './routing-container-manager.js';

describe('RoutingContainerManager', () => {
  it('delegates runtime exec calls by resolved execution target', async () => {
    const local = fakeContainerManager('local-container');
    const sandbox = fakeContainerManager('sandbox-container');
    const router = new RoutingContainerManager({
      local,
      sandbox,
      resolveTarget: (containerId) => (containerId === 'sandbox-1' ? 'sandbox' : 'local'),
    });

    await router.execInContainer('local-1', ['echo', 'local']);
    await router.execStreaming('sandbox-1', ['claude']);
    await router.writeFile('sandbox-1', '/tmp/file', 'content');

    expect(local.execInContainer).toHaveBeenCalledWith('local-1', ['echo', 'local'], undefined);
    expect(sandbox.execStreaming).toHaveBeenCalledWith('sandbox-1', ['claude'], undefined);
    expect(sandbox.writeFile).toHaveBeenCalledWith('sandbox-1', '/tmp/file', 'content');
    expect(local.execStreaming).not.toHaveBeenCalled();
  });

  it('falls back to the local manager when no sandbox manager is configured', async () => {
    const local = fakeContainerManager('local-container');
    const router = new RoutingContainerManager({
      local,
      resolveTarget: () => 'sandbox',
    });

    await router.execStreaming('sandbox-1', ['claude']);

    expect(local.execStreaming).toHaveBeenCalledWith('sandbox-1', ['claude'], undefined);
  });
});

function fakeContainerManager(id: string): ContainerManager {
  const execResult: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
  const streamingResult = (): StreamingExecResult => ({
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    exitCode: Promise.resolve(0),
    kill: vi.fn(async () => {}),
  });

  return {
    spawn: vi.fn(async (_config: ContainerSpawnConfig) => id),
    kill: vi.fn(async (_containerId: string) => {}),
    refreshFirewall: vi.fn(async (_containerId: string, _script: string) => {}),
    stop: vi.fn(async (_containerId: string) => {}),
    start: vi.fn(async (_containerId: string) => {}),
    writeFile: vi.fn(async (_containerId: string, _path: string, _content: string | Buffer) => {}),
    readFile: vi.fn(async (_containerId: string, _path: string) => ''),
    readFileBinary: vi.fn(async (_containerId: string, _path: string) => Buffer.from('')),
    extractDirectoryFromContainer: vi.fn(
      async (
        _containerId: string,
        _containerPath: string,
        _hostPath: string,
        _excludes?: string[],
      ) => {},
    ),
    getStatus: vi.fn(async (_containerId: string) => 'running'),
    execInContainer: vi.fn(
      async (_containerId: string, _command: string[], _options?: ExecOptions) => execResult,
    ),
    execStreaming: vi.fn(async (_containerId: string, _command: string[], _options?: ExecOptions) =>
      streamingResult(),
    ),
  };
}
