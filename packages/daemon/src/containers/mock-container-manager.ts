import { PassThrough } from 'node:stream';
import type { ContainerManager } from '../interfaces/index.js';

/**
 * No-op ContainerManager for dev mode (AUTOPOD_MOCK_DOCKER=true).
 * All operations succeed immediately without touching Docker.
 * Sessions started in this mode will not actually run containers.
 */
export function createDevMockContainerManager(): ContainerManager {
  return {
    spawn: async () => 'mock-container-dev',
    kill: async () => {},
    stop: async () => {},
    start: async () => {},
    refreshFirewall: async () => {},
    writeFile: async () => {},
    readFile: async () => '',
    getStatus: async () => 'running' as const,
    execInContainer: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    execStreaming: async () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.end();
      stderr.end();
      return {
        stdout,
        stderr,
        exitCode: Promise.resolve(0),
        kill: async () => {},
      };
    },
  };
}
