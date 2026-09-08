import type Dockerode from 'dockerode';
import pino from 'pino';
import { expect, it, vi } from 'vitest';
import { DockerContainerManager } from '../containers/docker-container-manager.js';

it('reconciles an exact existing Docker identity and never replaces a mismatched container', async () => {
  let digest = 'sha256:fixture';
  const inspect = vi.fn(async () => ({
    Id: 'container-one',
    Config: { Labels: { 'dispatcher.spec-digest': digest } },
    State: { Running: true },
  }));
  const create = vi.fn();
  const remove = vi.fn();
  const docker = {
    getContainer: vi.fn(() => ({ inspect, remove })),
    createContainer: create,
  } as unknown as Dockerode;
  const manager = new DockerContainerManager({ docker, logger: pino({ level: 'silent' }) });
  const firewall = vi.spyOn(manager, 'refreshFirewall').mockResolvedValue();
  const checkpoint = vi.fn();
  const config = {
    image: 'fixture',
    podId: 'pod-one',
    env: {},
    managedSpecDigest: 'sha256:fixture',
    firewallScript: 'deny',
    onCreated: checkpoint,
  };
  expect(await manager.ensureManagedContainer(config)).toBe('container-one');
  expect(checkpoint).toHaveBeenCalledWith('container-one');
  expect(firewall).toHaveBeenCalledTimes(1);
  digest = 'sha256:wrong';
  await expect(manager.ensureManagedContainer(config)).rejects.toThrow('binding-conflict');
  expect(create).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
