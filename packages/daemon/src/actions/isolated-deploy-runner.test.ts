import { createHash } from 'node:crypto';
import type Dockerode from 'dockerode';
import pino from 'pino';
import { pack } from 'tar-stream';
import { expect, it, vi } from 'vitest';
import { IsolatedDeployRunner } from './isolated-deploy-runner.js';

it('rejects changed source, unsafe environment and archive links before any Docker call', async () => {
  const getImage = vi.fn();
  const createContainer = vi.fn();
  const docker = { getImage, createContainer } as unknown as Dockerode;
  const runner = new IsolatedDeployRunner({
    docker,
    logger: pino({ level: 'silent' }),
    image: `fixture@sha256:${'a'.repeat(64)}`,
    memoryBytes: 128 * 1024 * 1024,
    cpus: 1,
    timeoutMs: 1000,
    allowedEnv: ['BASH_ENV'],
  });
  const input = {
    runId: 'fixture',
    sourceTar: Buffer.from('not-tar'),
    sourceDigest: 'a'.repeat(64),
    scriptPath: 'deploy.sh',
    args: [],
    env: {},
    assertCurrent: vi.fn(),
    recordContainer: vi.fn(),
    recordExec: vi.fn(),
  };
  await expect(runner.run(input)).rejects.toThrow('digest');
  input.sourceDigest = createHash('sha256').update(input.sourceTar).digest('hex');
  await expect(runner.run({ ...input, env: { BASH_ENV: '/workspace/inject.sh' } })).rejects.toThrow(
    'allowlist',
  );
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
  archive.entry({
    name: 'deploy.sh',
    type: 'symlink',
    linkname: '/etc/passwd',
    uid: 1000,
    gid: 1000,
  });
  archive.finalize();
  const sourceTar = await done;
  await expect(
    runner.run({
      ...input,
      sourceTar,
      sourceDigest: createHash('sha256').update(sourceTar).digest('hex'),
    }),
  ).rejects.toThrow('unsafe member');
  expect(getImage).not.toHaveBeenCalled();
  expect(createContainer).not.toHaveBeenCalled();
});
