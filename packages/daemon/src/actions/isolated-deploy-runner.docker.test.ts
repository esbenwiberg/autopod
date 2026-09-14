import { createHash, randomUUID } from 'node:crypto';
import Dockerode from 'dockerode';
import pino from 'pino';
import { pack } from 'tar-stream';
import { expect, it } from 'vitest';
import { IsolatedDeployRunner, type IsolatedDeploymentInput } from './isolated-deploy-runner.js';

async function source(script: string) {
  const archive = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (part: unknown) => {
      if (Buffer.isBuffer(part)) chunks.push(part);
      else reject(new Error('Invalid fixture archive'));
    });
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
  });
  archive.entry({ name: 'deploy.sh', uid: 1000, gid: 1000, mode: 0o755 }, script);
  archive.finalize();
  return done;
}
it.skipIf(!process.env.AUTOPOD_DEPLOY_DOCKER_FIXTURE_IMAGE)(
  'runs an approved bundle without host mounts or network and withholds secret output',
  async () => {
    const image = process.env.AUTOPOD_DEPLOY_DOCKER_FIXTURE_IMAGE;
    const socketPath = process.env.AUTOPOD_DEPLOY_DOCKER_FIXTURE_SOCKET;
    if (!image || !socketPath)
      throw new Error('Explicit cached image and local Docker socket required');
    const docker = new Dockerode({ socketPath });
    const containers: string[] = [];
    const runId = `fixture-${randomUUID()}`;
    const bundle = await source(
      'set -eu\ntest "$(id -u)" = 1000\ntest ! -e /var/run/docker.sock\ntest ! -d /home/autopod/.azure\ntest "$FIXTURE_SECRET" = only-in-deployment\ntouch /workspace/build-fixture\ntouch "$HOME/home-fixture"\ngrep -q "CapEff:.*0000000000000000" /proc/self/status\nprintf "%s" "$FIXTURE_SECRET"\n',
    );
    const runner = new IsolatedDeployRunner({
      docker,
      logger: pino({ level: 'silent' }),
      image,
      memoryBytes: 128 * 1024 * 1024,
      cpus: 0.5,
      timeoutMs: 5000,
      allowedEnv: ['FIXTURE_SECRET'],
    });
    let execRecorded = false;
    const input: IsolatedDeploymentInput = {
      runId,
      sourceTar: bundle,
      sourceDigest: createHash('sha256').update(bundle).digest('hex'),
      scriptPath: 'deploy.sh',
      args: [],
      env: { FIXTURE_SECRET: 'only-in-deployment' },
      assertCurrent() {},
      recordContainer(id) {
        containers.push(id);
      },
      recordExec() {
        execRecorded = true;
      },
    };
    try {
      const result = await runner.run(input);
      expect(execRecorded).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.outputBytes).toBeGreaterThan(0);
      expect(result.containerRemoved).toBe(true);
      expect(JSON.stringify(result)).not.toContain('only-in-deployment');
      for (const id of containers)
        await expect(docker.getContainer(id).inspect()).rejects.toMatchObject({ statusCode: 404 });
      const requests = await docker.listContainers({
        all: true,
        filters: JSON.stringify({ label: [`autopod.deployment-run=${runId}`] }),
      });
      expect(requests).toEqual([]);
    } finally {
      for (const id of containers)
        await docker
          .getContainer(id)
          .remove({ force: true, v: true })
          .catch((e: unknown) => {
            if ((e as { statusCode?: number }).statusCode !== 404) throw e;
          });
    }
  },
  15000,
);

it.skipIf(!process.env.AUTOPOD_DEPLOY_DOCKER_FIXTURE_IMAGE)(
  'removes a timed-out runner without returning an execution receipt',
  async () => {
    const image = process.env.AUTOPOD_DEPLOY_DOCKER_FIXTURE_IMAGE;
    const socketPath = process.env.AUTOPOD_DEPLOY_DOCKER_FIXTURE_SOCKET;
    if (!image || !socketPath) throw new Error('Fixture configuration missing');
    const docker = new Dockerode({ socketPath });
    const bundle = await source('sleep 30\n');
    const containers: string[] = [];
    const runner = new IsolatedDeployRunner({
      docker,
      logger: pino({ level: 'silent' }),
      image,
      memoryBytes: 128 * 1024 * 1024,
      cpus: 0.5,
      timeoutMs: 100,
      allowedEnv: [],
    });
    await expect(
      runner.run({
        runId: `timeout-${randomUUID()}`,
        sourceTar: bundle,
        sourceDigest: createHash('sha256').update(bundle).digest('hex'),
        scriptPath: 'deploy.sh',
        args: [],
        env: {},
        assertCurrent() {},
        recordContainer(id) {
          containers.push(id);
        },
        recordExec() {},
      }),
    ).rejects.toThrow('deadline');
    for (const id of containers)
      await expect(docker.getContainer(id).inspect()).rejects.toMatchObject({ statusCode: 404 });
  },
  15000,
);
