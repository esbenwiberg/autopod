import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SandboxApiClient } from './sandbox-api-client.js';
import { exportSandboxWorkspace } from './sandbox-workspace-export.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sandbox-export-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Header = Parameters<ReturnType<typeof pack>['entry']>[0];
async function archive(entries: Array<{ header: Header; content?: Buffer }>): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const result = (async () => {
    for await (const chunk of tar) chunks.push(Buffer.from(chunk));
    return gzipSync(Buffer.concat(chunks));
  })();
  for (const { header, content } of entries) {
    await new Promise<void>((resolve, reject) =>
      tar.entry(header, content ?? Buffer.alloc(0), (err) => (err ? reject(err) : resolve())),
    );
  }
  tar.finalize();
  return result;
}

function clientFor(content: Buffer) {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < content.length; offset += 8 * 1024 * 1024) {
    parts.push(content.subarray(offset, offset + 8 * 1024 * 1024));
  }
  const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  const read = vi.fn(async (_id: string, name: string) => {
    const part = parts[Number(name.split('part-').at(-1))];
    if (!part) throw new Error('Missing chunk');
    return part;
  });
  const client = {
    exec,
    readFile: read,
    listFiles: async () => ({
      entries: parts.map((_part, index) => ({ name: `part-${String(index).padStart(8, '0')}` })),
    }),
  } as unknown as SandboxApiClient;
  return { client, exec, read };
}

it('streams multiple bounded chunks and preserves executable modes and dependency symlinks', async () => {
  const content = randomBytes(9 * 1024 * 1024);
  const fake = clientFor(
    await archive([
      { header: { name: './', type: 'directory', mode: 0o755 } },
      { header: { name: './run.sh', mode: 0o755 }, content: Buffer.from('#!/bin/sh\n') },
      { header: { name: './node_modules/.pnpm/dependency/index.js' }, content },
      {
        header: {
          name: './node_modules/dependency',
          type: 'symlink',
          linkname: '.pnpm/dependency',
        },
      },
    ]),
  );
  await exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root);
  expect(fake.read).toHaveBeenCalledTimes(2);
  expect((await readFile(join(root, 'node_modules/dependency/index.js'))).equals(content)).toBe(
    true,
  );
  expect(await readlink(join(root, 'node_modules/dependency'))).toBe('.pnpm/dependency');
  expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755);
  expect(fake.exec.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(['rm', '-rf', '--']));
});

it.each(['../escape', '/absolute', 'a/../../escape'])(
  'rejects unsafe archive member %s and cleans remote chunks',
  async (name) => {
    const fake = clientFor(await archive([{ header: { name }, content: Buffer.from('unsafe') }]));
    await expect(
      exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root),
    ).rejects.toThrow('Unsafe sandbox archive entry path');
    expect(fake.exec).toHaveBeenCalledTimes(2);
  },
);

it('rejects symlink parent traversal without writing through the link', async () => {
  const fake = clientFor(
    await archive([
      { header: { name: 'escape', type: 'symlink', linkname: tmpdir() } },
      { header: { name: 'escape/file' }, content: Buffer.from('unsafe') },
    ]),
  );
  await expect(exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root)).rejects.toThrow(
    'Sandbox archive writes through a symlink',
  );
});

it('materialises hardlinks as independent copies of already-extracted files', async () => {
  const fake = clientFor(
    await archive([
      { header: { name: './bin/tool', mode: 0o755 }, content: Buffer.from('tool') },
      { header: { name: './bin/alias', type: 'link', linkname: './bin/tool', mode: 0o755 } },
    ]),
  );
  await exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root);
  expect(await readFile(join(root, 'bin/alias'), 'utf8')).toBe('tool');
  expect((await stat(join(root, 'bin/alias'))).mode & 0o777).toBe(0o755);
  expect((await stat(join(root, 'bin/alias'))).nlink).toBe(1);
  expect(fake.exec.mock.calls[0]?.[1]?.[2]).not.toContain('--hard-dereference');
});

it.each([
  ['an unseen member', 'missing'],
  ['a path outside staging', '../escape'],
  ['a symlink member', 'link'],
])('rejects a hardlink to %s', async (_label, linkname) => {
  const fake = clientFor(
    await archive([
      { header: { name: 'link', type: 'symlink', linkname: tmpdir() } },
      { header: { name: 'alias', type: 'link', linkname } },
    ]),
  );
  await expect(exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root)).rejects.toThrow(
    /hardlink to unknown file|Unsafe sandbox archive entry path/,
  );
  expect(fake.exec).toHaveBeenCalledTimes(2);
});

it('rejects truncated download instead of publishing a partial archive', async () => {
  const data = await archive([{ header: { name: 'report.md' }, content: Buffer.from('report') }]);
  const fake = clientFor(data.subarray(0, data.length - 8));
  await expect(
    exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root),
  ).rejects.toThrow();
  expect(fake.exec).toHaveBeenCalledTimes(2);
});

it('retains an archive command failure and cleans its temporary directory', async () => {
  const fake = clientFor(Buffer.alloc(0));
  fake.exec.mockResolvedValueOnce({ stdout: '', stderr: 'No space left on device', exitCode: 2 });
  await expect(exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root)).rejects.toThrow(
    'No space left on device',
  );
  expect(fake.read).not.toHaveBeenCalled();
  expect(fake.exec).toHaveBeenCalledTimes(2);
});

it('does not download an export after its owner is superseded', async () => {
  const fake = clientFor(
    await archive([{ header: { name: 'report.md' }, content: Buffer.from('report') }]),
  );
  let current = true;
  fake.exec.mockImplementationOnce(async () => {
    current = false;
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  await expect(
    exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root, {
      assertCurrent() {
        if (!current) throw new Error('superseded');
      },
    }),
  ).rejects.toThrow('superseded');
  expect(fake.read).not.toHaveBeenCalled();
  expect(fake.exec).toHaveBeenCalledTimes(2);
});

it('rejects zero-exit archive warnings instead of silently omitting workspace entries', async () => {
  const fake = clientFor(
    await archive([{ header: { name: 'report.md' }, content: Buffer.from('report') }]),
  );
  fake.exec.mockResolvedValueOnce({
    stdout: '',
    stderr: 'tar: ./worker.sock: socket ignored\n',
    exitCode: 0,
  });
  await expect(exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root)).rejects.toThrow(
    'socket ignored',
  );
  expect(fake.read).not.toHaveBeenCalled();
  expect(fake.exec).toHaveBeenCalledTimes(2);
});

it('passes excludes to tar as argv and drops excluded entries the remote tar kept', async () => {
  const fake = clientFor(
    await archive([
      { header: { name: './', type: 'directory', mode: 0o755 } },
      { header: { name: './dispatcher-output/implement.md' }, content: Buffer.from('report') },
      { header: { name: './.git/HEAD' }, content: Buffer.from('ref: refs/heads/main\n') },
      { header: { name: './pkg/node_modules/dep/index.js' }, content: Buffer.from('dep') },
      { header: { name: './reports/raw/big.log' }, content: Buffer.from('raw') },
      { header: { name: './reports/summary.md' }, content: Buffer.from('summary') },
      { header: { name: './a/reports/raw/keep.md' }, content: Buffer.from('nested') },
    ]),
  );
  await exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root, undefined, undefined, [
    '.git',
    'node_modules',
    'reports/raw',
  ]);
  const argv = fake.exec.mock.calls[0]?.[1] as string[];
  // Excludes ride as positional argv after the fixed operands, never inside the script.
  expect(argv.slice(-2)).toEqual(['--exclude=.git', '--exclude=node_modules']);
  // bsdtar would also drop nested `*/reports/raw`, so slashed paths are host-filtered.
  expect(argv.some((arg) => arg.includes('reports/raw'))).toBe(false);
  expect(argv[2]).not.toContain('node_modules');
  expect(await readFile(join(root, 'dispatcher-output/implement.md'), 'utf8')).toBe('report');
  expect(await readFile(join(root, 'reports/summary.md'), 'utf8')).toBe('summary');
  expect(await readFile(join(root, 'a/reports/raw/keep.md'), 'utf8')).toBe('nested');
  await expect(stat(join(root, '.git'))).rejects.toThrow();
  await expect(stat(join(root, 'pkg/node_modules'))).rejects.toThrow();
  await expect(stat(join(root, 'reports/raw'))).rejects.toThrow();
});

it.each(['*.log', '--checkpoint-action=exec=sh', 'a/../b', 'line\nbreak', '[ab]'])(
  'rejects exclude %j before touching the sandbox',
  async (exclude) => {
    const fake = clientFor(await archive([]));
    await expect(
      exportSandboxWorkspace(fake.client, 'sandbox', '/workspace', root, undefined, undefined, [
        exclude,
      ]),
    ).rejects.toThrow('Unsupported sandbox export exclude');
    expect(fake.exec).not.toHaveBeenCalled();
  },
);
