import type { NativeGoalProcessIdentity } from '@autopod/shared';
import Dockerode from 'dockerode';
import pino from 'pino';
import { expect, it } from 'vitest';
import { DockerContainerManager } from './docker-container-manager.js';

/** Opt-in local backend proof. Uses one cached image, no mounts, no network, no credentials. */
it.skipIf(!process.env.AUTOPOD_GOAL_DOCKER_FIXTURE_IMAGE)(
  'recovers the exact Docker exec and its children while preserving other processes',
  async () => {
    const image = process.env.AUTOPOD_GOAL_DOCKER_FIXTURE_IMAGE;
    const socketPath = process.env.AUTOPOD_GOAL_DOCKER_FIXTURE_SOCKET;
    if (!image?.startsWith('sha256:') || !socketPath)
      throw new Error('Explicit cached image ID and local socket required');
    const docker = new Dockerode({ socketPath });
    await docker.getImage(image).inspect();
    const container = await docker.createContainer({
      Image: image,
      Cmd: ['sleep', '300'],
      User: '1000:1000',
      Labels: { 'autopod.fixture': 'native-goal-recovery' },
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=16m,mode=1777' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 134217728,
        PidsLimit: 64,
      },
    });
    const logger = pino({ level: 'silent' });
    try {
      await container.start();
      const first = new DockerContainerManager({ docker, logger });
      let saved: NativeGoalProcessIdentity | undefined;
      let started = false;
      const original = await first.execStreaming(container.id, ['sh', '-c', 'sleep 240 & wait'], {
        onProcessCreated(identity) {
          saved = structuredClone(identity);
        },
        onProcessStarted() {
          started = true;
        },
      });
      expect(started).toBe(true);
      if (!saved) throw new Error('Identity was not recorded');
      // Readiness is observed in the fixture, not inferred from a delay or transport open.
      const ready = await first.execInContainer(container.id, [
        'sh',
        '-c',
        `test -s ${saved.pidPath}`,
      ]);
      expect(ready.exitCode).toBe(0);
      let independentId: string | undefined;
      const independent = await first.execStreaming(container.id, ['sleep', '240'], {
        onProcessCreated(identity) {
          independentId = identity.execId;
        },
      });
      const recovered = new DockerContainerManager({
        docker: new Dockerode({ socketPath }),
        logger,
      });
      const exit = await recovered.terminateRecordedExec(saved);
      expect(Number.isInteger(exit)).toBe(true);
      expect(await original.exitCode).toBe(exit);
      expect((await docker.getExec(saved.execId).inspect()).Running).toBe(false);
      if (!independentId) throw new Error('Missing independent exec identity');
      expect((await docker.getExec(independentId).inspect()).Running).toBe(true);
      expect(await recovered.getStatus(container.id)).toBe('running');
      await independent.kill();
      await independent.exitCode;
      expect(await recovered.terminateRecordedExec(saved)).toBe(exit);
    } finally {
      await container.remove({ force: true });
    }
  },
  15000,
);
