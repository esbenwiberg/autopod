import { randomUUID } from 'node:crypto';
import Dockerode from 'dockerode';
import pino from 'pino';
import { expect, it } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { DockerContainerManager } from './docker-container-manager.js';
import { DockerNetworkManager } from './docker-network-manager.js';
import { launchSidecarSpec } from './launch-sidecars.js';
import { DockerSidecarManager } from './sidecar-manager.js';

/** No host mounts, published ports, external requests or real account credentials. */
it.skipIf(!process.env.AUTOPOD_SIDECAR_DOCKER_FIXTURE_IMAGE)(
  'isolates two real PostgreSQL sidecars while preserving same-pod access',
  async () => {
    const image = process.env.AUTOPOD_SIDECAR_DOCKER_FIXTURE_IMAGE;
    const socketPath = process.env.AUTOPOD_SIDECAR_DOCKER_FIXTURE_SOCKET;
    if (!image?.includes('@sha256:') || !socketPath)
      throw new Error('Explicit cached image and local socket required');
    const docker = new Dockerode({ socketPath });
    await docker.getImage(image).inspect();
    const created: Dockerode.Container[] = [];
    const create = docker.createContainer.bind(docker);
    docker.createContainer = (async (options: Dockerode.ContainerCreateOptions) => {
      const container = await create(options);
      created.push(container);
      return container;
    }) as typeof docker.createContainer;
    const logger = pino({ level: 'silent' });
    const networks = new DockerNetworkManager({ docker, logger });
    const sidecars = new DockerSidecarManager({ docker, logger });
    const containers = new DockerContainerManager({ docker, logger });
    const suffix = randomUUID().slice(0, 8);
    const podIds = [`fixture-a-${suffix}`, `fixture-b-${suffix}`];
    const workers: string[] = [];
    const ips: string[] = [];
    let cleanup: PromiseSettledResult<unknown>[] = [];
    const db = createTestDb();
    try {
      const { services } = createTestConfiguration(db);
      const config = await resolveLaunch(
        {
          repositoryId: 'repo-a',
          task: 'Sidecar fixture',
          overrides: {
            environment: {
              sidecars: [
                {
                  id: 'db',
                  type: 'postgres',
                  image,
                  version: '17',
                  port: 5432,
                  startup: 'always',
                  healthTimeoutMs: 15000,
                },
              ],
            },
            execution: { sidecars: { db: { memoryGb: 0.25, cpus: 0.5 } } },
          },
        },
        services,
      );
      const password = 'local-fixture-credential-only-1234';
      for (const podId of podIds) {
        const networkName = await networks.ensureNetworkForPod(podId);
        const { spec } = launchSidecarSpec(config, 'db', password);
        const sidecar = await sidecars.spawn({ spec, podId, networkName });
        await sidecars.waitHealthy(sidecar, spec);
        const info = await docker.getContainer(sidecar.containerId).inspect();
        expect(info.HostConfig.Privileged).toBe(false);
        expect(info.HostConfig.Memory).toBe(256 * 1024 * 1024);
        expect(info.HostConfig.NanoCpus).toBe(500_000_000);
        expect(info.HostConfig.PidsLimit).toBe(256);
        expect(Object.values(info.NetworkSettings.Ports).every((value) => value === null)).toBe(
          true,
        );
        const ip = await sidecars.getBridgeIp(sidecar, networkName);
        if (!ip) throw new Error('Missing sidecar bridge identity');
        ips.push(ip);
        const worker = await docker.createContainer({
          Image: image,
          Entrypoint: ['sleep'],
          Cmd: ['120'],
          User: '1000:1000',
          Labels: { 'autopod.fixture': 'sidecar-isolation' },
          HostConfig: {
            NetworkMode: networkName,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            Memory: 134217728,
            PidsLimit: 32,
          },
        });
        await worker.start();
        workers.push(worker.id);
        const own = await containers.execInContainer(
          worker.id,
          [
            'psql',
            '-h',
            'db',
            '-U',
            'autopod',
            '-d',
            'autopod',
            '-Atc',
            'select host(inet_server_addr())',
          ],
          { env: { PGPASSWORD: password }, timeout: 5000 },
        );
        expect(own, own.stderr).toMatchObject({ exitCode: 0, stdout: `${ip}\n` });
      }
      for (const [index, worker] of workers.entries()) {
        const foreign = ips[1 - index];
        if (!foreign) throw new Error('Missing foreign fixture');
        const probe = await containers.execInContainer(
          worker,
          ['pg_isready', '-h', foreign, '-p', '5432', '-t', '1'],
          { timeout: 4000 },
        );
        expect(probe.exitCode).not.toBe(0);
      }
    } finally {
      db.close();
      cleanup = await Promise.allSettled(
        created.map((container) => container.remove({ force: true, v: true })),
      );
      for (const podId of podIds) await networks.removeNetworkForPod(podId);
    }
    expect(cleanup.every((result) => result.status === 'fulfilled')).toBe(true);
  },
  45000,
);
