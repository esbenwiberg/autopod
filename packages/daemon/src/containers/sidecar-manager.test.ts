import type { SidecarSpec } from '@autopod/shared';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerSidecarManager, SidecarHealthTimeoutError } from './sidecar-manager.js';

const logger = pino({ level: 'silent' });

const daggerSpec: SidecarSpec = {
  type: 'dagger-engine',
  name: 'dagger',
  image: `registry.dagger.io/engine@sha256:${'a'.repeat(64)}`,
  healthCheck: { port: 8080, timeoutMs: 2_000, intervalMs: 50 },
  resources: { memoryMb: 2048, cpus: 1, pidsLimit: 4096, storageMb: 10_240 },
  privileged: true,
};

interface MockContainer {
  id: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
}

function mockContainer(overrides: Partial<MockContainer> = {}): MockContainer {
  return {
    id: 'sidecar-container-abc',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue({ State: { Running: true, ExitCode: 0 } }),
    ...overrides,
  };
}

function mockDocker(
  container: MockContainer,
  opts: Partial<{
    imageExists: boolean;
    listContainers: Dockerode.ContainerInfo[];
  }> = {},
) {
  const imageInspect =
    opts.imageExists === false
      ? vi.fn().mockRejectedValue(Object.assign(new Error('no such image'), { statusCode: 404 }))
      : vi.fn().mockResolvedValue({ Id: 'sha256:abc' });
  return {
    createContainer: vi.fn().mockResolvedValue(container),
    getContainer: vi.fn().mockReturnValue(container),
    getImage: vi.fn().mockReturnValue({ inspect: imageInspect }),
    pull: vi.fn().mockResolvedValue({}),
    listContainers: vi.fn().mockResolvedValue(opts.listContainers ?? []),
    modem: {
      followProgress: vi.fn((_stream: unknown, done: (err: Error | null) => void) => {
        done(null);
      }),
    },
  } as unknown as Dockerode & {
    createContainer: ReturnType<typeof vi.fn>;
    getContainer: ReturnType<typeof vi.fn>;
    getImage: ReturnType<typeof vi.fn>;
    pull: ReturnType<typeof vi.fn>;
    listContainers: ReturnType<typeof vi.fn>;
  };
}

describe('DockerSidecarManager', () => {
  let container: MockContainer;
  let docker: ReturnType<typeof mockDocker>;
  let manager: DockerSidecarManager;

  beforeEach(() => {
    container = mockContainer();
    docker = mockDocker(container);
    manager = new DockerSidecarManager({ docker, logger });
  });

  describe('spawn()', () => {
    it('creates a privileged container with resource limits + labels and returns a handle', async () => {
      const handle = await manager.spawn({
        spec: daggerSpec,
        podId: 'pod-xyz',
        networkName: 'autopod-pod-xyz-net',
      });

      expect(handle).toEqual({ containerId: 'sidecar-container-abc', name: 'dagger' });
      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      const createArgs = docker.createContainer.mock
        .calls[0]?.[0] as Dockerode.ContainerCreateOptions;
      expect(createArgs.name).toBe('autopod-pod-xyz-dagger');
      expect(createArgs.Image).toBe(daggerSpec.image);
      expect(createArgs.Labels).toMatchObject({
        'com.autopod.is-sidecar': 'true',
        'com.autopod.pod-id': 'pod-xyz',
        'com.autopod.sidecar-name': 'dagger',
        'com.autopod.sidecar-type': 'dagger-engine',
      });
      const hostConfig = createArgs.HostConfig as Record<string, unknown>;
      expect(hostConfig.NetworkMode).toBe('autopod-pod-xyz-net');
      expect(hostConfig.Privileged).toBe(true);
      expect(hostConfig.PidsLimit).toBe(4096);
      expect(hostConfig.NanoCpus).toBe(1_000_000_000);
      // Memory is 2GB aligned to 4k page size.
      expect(hostConfig.Memory).toBe(2048 * 1024 * 1024);
      expect(container.start).toHaveBeenCalled();
    });

    it('pulls the image when not present locally, then creates the container', async () => {
      docker = mockDocker(container, { imageExists: false });
      manager = new DockerSidecarManager({ docker, logger });

      await manager.spawn({ spec: daggerSpec, podId: 'pod-a', networkName: 'net-a' });

      expect(docker.pull).toHaveBeenCalledWith(daggerSpec.image);
      expect(docker.createContainer).toHaveBeenCalled();
    });

    it('does not pull when the image is already present', async () => {
      await manager.spawn({ spec: daggerSpec, podId: 'pod-a', networkName: 'net-a' });
      expect(docker.pull).not.toHaveBeenCalled();
    });
  });

  describe('kill()', () => {
    it('stops and removes the container', async () => {
      await manager.kill('some-id');
      expect(container.stop).toHaveBeenCalled();
      expect(container.remove).toHaveBeenCalledWith({ force: true });
    });

    it('is idempotent when the container is already gone (404)', async () => {
      container.stop = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
      container.remove = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
      await expect(manager.kill('some-id')).resolves.not.toThrow();
    });

    it('rethrows unexpected errors', async () => {
      container.stop = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));
      await expect(manager.kill('some-id')).rejects.toThrow('boom');
    });
  });

  describe('reconcileOrphans()', () => {
    it('kills sidecars whose pod-id is not in the active set, in parallel', async () => {
      docker = mockDocker(container, {
        listContainers: [
          {
            Id: 'a',
            Labels: { 'com.autopod.pod-id': 'pod-live', 'com.autopod.sidecar-name': 'dagger' },
          } as Dockerode.ContainerInfo,
          {
            Id: 'b',
            Labels: { 'com.autopod.pod-id': 'pod-dead', 'com.autopod.sidecar-name': 'dagger' },
          } as Dockerode.ContainerInfo,
          {
            Id: 'c',
            Labels: { 'com.autopod.pod-id': 'pod-also-dead', 'com.autopod.sidecar-name': 'dagger' },
          } as Dockerode.ContainerInfo,
        ],
      });
      manager = new DockerSidecarManager({ docker, logger });

      const reaped = await manager.reconcileOrphans(new Set(['pod-live']));

      expect(reaped).toBe(2);
      // Two kills; getContainer called once per orphan
      expect(docker.getContainer).toHaveBeenCalledWith('b');
      expect(docker.getContainer).toHaveBeenCalledWith('c');
      expect(docker.getContainer).not.toHaveBeenCalledWith('a');
    });

    it('returns 0 when every sidecar belongs to a live pod', async () => {
      docker = mockDocker(container, {
        listContainers: [
          {
            Id: 'a',
            Labels: { 'com.autopod.pod-id': 'pod-1' },
          } as Dockerode.ContainerInfo,
        ],
      });
      manager = new DockerSidecarManager({ docker, logger });

      expect(await manager.reconcileOrphans(new Set(['pod-1']))).toBe(0);
    });
  });

  describe('waitHealthy()', () => {
    it('returns once the container reports Running and exit code 0', async () => {
      container.inspect = vi.fn().mockResolvedValue({ State: { Running: true, ExitCode: 0 } });
      await expect(
        manager.waitHealthy({ containerId: 'x', name: 'dagger' }, daggerSpec),
      ).resolves.not.toThrow();
    });

    it('throws SidecarHealthTimeoutError if the container never becomes healthy', async () => {
      container.inspect = vi.fn().mockResolvedValue({ State: { Running: false, ExitCode: 0 } });
      const shortSpec: SidecarSpec = {
        ...daggerSpec,
        healthCheck: { port: 8080, timeoutMs: 100, intervalMs: 10 },
      };
      await expect(
        manager.waitHealthy({ containerId: 'x', name: 'dagger' }, shortSpec),
      ).rejects.toBeInstanceOf(SidecarHealthTimeoutError);
    });
  });
});
