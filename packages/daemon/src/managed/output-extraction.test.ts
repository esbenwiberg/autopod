import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ArtifactOutput } from '@autopod/shared';
import tar from 'tar-stream';
import { afterEach, expect, it, vi } from 'vitest';
import { collectOutput } from './artifact-collector.js';
import { sha256 } from './canonical.js';
import { extractManagedDockerOutput, extractManagedSandboxOutput } from './output-extraction.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const output: ArtifactOutput = {
  mode: 'required',
  root: '/output',
  requiredPaths: ['research.md'],
  include: ['**/*'],
  exclude: [],
  limits: { maxFiles: 5, maxFileBytes: 1000, maxTotalBytes: 1000 },
  links: { allowHardlinks: false, allowSymlinks: false },
};
async function root() {
  const value = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-extract-')));
  roots.push(value);
  return value;
}

it('Docker and Sandbox extraction feed one collector with matching normalized bytes', async () => {
  const base = await root();
  const bytes = Buffer.from('# Same output\n');
  const pack = tar.pack();
  pack.entry({ name: 'output/research.md', uid: 1234, mtime: new Date(100000) }, bytes);
  pack.finalize();
  await extractManagedDockerOutput(pack, path.join(base, 'docker'), output);
  await extractManagedSandboxOutput(
    [{ path: 'research.md', size: bytes.length, sha256: sha256(bytes) }],
    async () => bytes,
    path.join(base, 'sandbox'),
    output,
  );
  const docker = await collectOutput(path.join(base, 'docker'), output);
  const sandbox = await collectOutput(path.join(base, 'sandbox'), output);
  expect(docker?.bundle).toEqual(sandbox?.bundle);
  expect(docker?.files).toEqual(sandbox?.files);
});
it.each(['symlink', 'link', 'character-device', 'fifo'] as const)(
  'rejects Docker %s before writing staging content',
  async (type) => {
    const base = await root();
    const pack = tar.pack();
    pack.entry({ name: 'output/unsafe', type, linkname: '/outside' });
    pack.finalize();
    await expect(
      extractManagedDockerOutput(pack, path.join(base, 'staging'), output),
    ).rejects.toThrow('unsafe-entry');
  },
);
it('rejects traversal and oversized extraction before writes', async () => {
  const base = await root();
  const pack = tar.pack();
  pack.entry({ name: 'output/../../outside' }, 'bad');
  pack.finalize();
  await expect(extractManagedDockerOutput(pack, path.join(base, 'docker'), output)).rejects.toThrow(
    'unsafe-entry',
  );
  await expect(
    extractManagedSandboxOutput(
      [{ path: '../outside', size: 1, sha256: 'bad' }],
      async () => Buffer.from('x'),
      path.join(base, 'sandbox'),
      output,
    ),
  ).rejects.toThrow('invalid-inventory');
});

it('accepts a Node readable source as well as the tar pack stream', async () => {
  const base = await root();
  const pack = tar.pack();
  const stream = new PassThrough();
  pack.entry({ name: 'output/research.md' }, Buffer.from('Node stream'));
  pack.finalize();
  pack.pipe(stream);
  await extractManagedDockerOutput(stream, path.join(base, 'node-stream'), output);
  const result = await collectOutput(path.join(base, 'node-stream'), output);
  expect(result?.files[0]?.path).toBe('research.md');
});
it('rejects a nonbinary extraction chunk before writing output', async () => {
  const base = await root();
  const original = tar.extract;
  vi.spyOn(tar, 'extract').mockImplementationOnce(() => {
    const extractor = original();
    extractor.on('entry', (_header, entry) => {
      queueMicrotask(() => entry.emit('data', { unexpected: true }));
    });
    return extractor;
  });
  const pack = tar.pack();
  pack.entry({ name: 'output/research.md' }, Buffer.from('Facts'));
  pack.finalize();
  await expect(
    extractManagedDockerOutput(pack, path.join(base, 'nonbinary'), output),
  ).rejects.toThrow('artifact-nonbinary-chunk');
});

it('rejects a nonbinary packing chunk without returning an artifact bundle', async () => {
  const base = await root();
  await writeFile(path.join(base, 'research.md'), 'Facts');
  const original = tar.pack;
  vi.spyOn(tar, 'pack').mockImplementationOnce(() => {
    const pack = original();
    pack.once('data', () => pack.emit('data', { unexpected: true }));
    return pack;
  });
  await expect(collectOutput(base, output)).rejects.toThrow('artifact-nonbinary-chunk');
});
