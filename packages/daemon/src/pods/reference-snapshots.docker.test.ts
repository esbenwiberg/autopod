import { gzipSync } from 'node:zlib';
import Dockerode from 'dockerode';
import pino from 'pino';
import tar from 'tar-stream';
import { expect, it } from 'vitest';
import { DockerContainerManager } from '../containers/docker-container-manager.js';
import { installReferenceSnapshots } from './reference-snapshots.js';

it.skipIf(!process.env.AUTOPOD_REFERENCE_DOCKER_FIXTURE_IMAGE)(
  'keeps installed reference source readable but immutable to the real agent user',
  async () => {
    const image = process.env.AUTOPOD_REFERENCE_DOCKER_FIXTURE_IMAGE;
    const socketPath = process.env.AUTOPOD_REFERENCE_DOCKER_FIXTURE_SOCKET;
    if (!image?.startsWith('sha256:') || !socketPath)
      throw new Error('Explicit cached image and local socket required');
    const docker = new Dockerode({ socketPath });
    await docker.getImage(image).inspect();
    const container = await docker.createContainer({
      Image: image,
      Cmd: ['sleep', '300'],
      User: '1000:1000',
      Labels: { 'autopod.fixture': 'reference-snapshots' },
      HostConfig: {
        NetworkMode: 'none',
        // Match normal agent containers; reference immutability comes from ownership.
        ReadonlyRootfs: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 134217728,
        PidsLimit: 64,
      },
    });
    try {
      await container.start();
      const pack = tar.pack();
      pack.entry({ name: 'README.md', mode: 0o644 }, 'frozen reference\n');
      pack.finalize();
      const chunks: Buffer[] = [];
      for await (const chunk of pack) chunks.push(Buffer.from(chunk));
      const archives = new Map([['1-fixture', gzipSync(Buffer.concat(chunks))]]);
      const manager = new DockerContainerManager({ docker, logger: pino({ level: 'silent' }) });
      const execute = manager.execInContainer.bind(manager);
      manager.execInContainer = async (...args) => {
        const result = await execute(...args);
        if (args[2]?.user === 'root' && result.exitCode !== 0)
          throw new Error(`Fixture preparation ${args[1][0]} failed: ${result.stderr}`);
        return result;
      };
      await installReferenceSnapshots(archives, manager, container.id);
      expect(archives.size).toBe(0);
      const read = await manager.execInContainer(container.id, [
        'sh',
        '-c',
        'id -u; cat /repos/1-fixture/README.md; test ! -e /repos/1-fixture/.git',
      ]);
      expect(read).toMatchObject({ exitCode: 0, stdout: '1000\nfrozen reference\n' });
      for (const command of [
        'printf changed >> /repos/1-fixture/README.md',
        'chmod u+w /repos/1-fixture/README.md',
        'rm /repos/1-fixture/README.md',
        'mv /repos/1-fixture /repos/replaced',
      ])
        expect(
          (await manager.execInContainer(container.id, ['sh', '-c', command])).exitCode,
        ).not.toBe(0);
      expect(
        (await manager.execInContainer(container.id, ['cat', '/repos/1-fixture/README.md'])).stdout,
      ).toBe('frozen reference\n');
    } finally {
      await container.remove({ force: true });
    }
  },
  15000,
);
