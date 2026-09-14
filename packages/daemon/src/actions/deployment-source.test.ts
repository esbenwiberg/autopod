import { gzipSync } from 'node:zlib';
import { extract, pack } from 'tar-stream';
import { expect, it } from 'vitest';
import { prepareDeploymentSource } from './deployment-source.js';

async function archive(name = 'deploy.sh', content = 'echo fixture\n', metadata = {}) {
  const output = pack();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    output.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else reject(new Error('Invalid fixture archive'));
    });
    output.on('end', () => resolve(Buffer.concat(chunks)));
    output.on('error', reject);
  });
  output.entry({ name, mode: 0o4755, uid: 0, gid: 0, mtime: new Date(), ...metadata }, content);
  output.finalize();
  return done;
}
it('normalizes ownership and mode while binding the exact script and complete source', async () => {
  const raw = await archive();
  const prepared = await prepareDeploymentSource(gzipSync(raw), 'deploy.sh');
  expect(prepared.scriptContent).toBe('echo fixture\n');
  const second = await prepareDeploymentSource(
    await archive('deploy.sh', 'echo fixture\n', { uid: 501, mtime: new Date(0) }),
    'deploy.sh',
  );
  expect(second.sourceDigest).toBe(prepared.sourceDigest);
  expect(
    (await prepareDeploymentSource(await archive('deploy.sh', 'echo changed\n'), 'deploy.sh'))
      .sourceDigest,
  ).not.toBe(prepared.sourceDigest);
  const reader = extract();
  const headers: unknown[] = [];
  const done = new Promise<void>((resolve, reject) => {
    reader.on('finish', resolve);
    reader.on('error', reject);
  });
  reader.on('entry', (header, stream, next) => {
    headers.push(header);
    stream.on('end', next);
    stream.resume();
  });
  reader.end(prepared.sourceTar);
  await done;
  expect(headers).toEqual([
    expect.objectContaining({ name: 'deploy.sh', uid: 1000, gid: 1000, mode: 0o755 }),
  ]);
});
it('rejects source metadata paths and missing scripts', async () => {
  await expect(prepareDeploymentSource(await archive('.git/config'), 'deploy.sh')).rejects.toThrow(
    'unsafe member',
  );
  await expect(prepareDeploymentSource(await archive('../deploy.sh'), 'deploy.sh')).rejects.toThrow(
    'unsafe member',
  );
  await expect(prepareDeploymentSource(await archive('other.sh'), 'deploy.sh')).rejects.toThrow(
    'absent',
  );
});
