import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';
import type { SandboxApiClient } from '../containers/sandbox-api-client.js';
import { exportSandboxWorkspace } from '../containers/sandbox-workspace-export.js';

// Run in a plain child process: Vitest's uncaught-error handler must not turn a
// daemon-killing tar entry error into an apparently ordinary rejected promise.
async function main() {
  const mode = process.argv[2];
  const staging = await mkdtemp(join(tmpdir(), 'sandbox-export-failure-'));
  const controller = new AbortController();
  let current = true;
  let cleanupCount = 0;
  let reads = 0;
  const tar = pack();
  const buffers: Buffer[] = [];
  const content = (async () => {
    for await (const chunk of tar) {
      assert.ok(Buffer.isBuffer(chunk));
      buffers.push(Buffer.from(chunk));
    }
    return gzipSync(Buffer.concat(buffers));
  })();
  const excluded = mode === 'excluded-download';
  tar.entry(
    { name: mode === 'unsafe' ? '../escape' : excluded ? 'reports/raw/large' : 'report' },
    excluded ? randomBytes(9 * 1024 * 1024) : Buffer.alloc(1024 * 1024, 65),
  );
  tar.finalize();
  const archive = await content;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < archive.length; offset += 8 * 1024 * 1024)
    parts.push(archive.subarray(offset, offset + 8 * 1024 * 1024));
  const failure = new Error('synthetic download failure');
  const client = {
    exec: async (_id: string, command: string[]) => {
      if (command[0] === 'rm') {
        assert.deepEqual(command.slice(0, 3), ['rm', '-rf', '--']);
        assert.match(command[3] ?? '', /^\/tmp\/\.autopod-export-/);
        cleanupCount++;
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    listFiles: async () => ({
      entries: parts.map((_, index) => ({ name: `part-${String(index).padStart(8, '0')}` })),
    }),
    readFile: async () => {
      const index = reads++;
      if (mode === 'abort') controller.abort();
      if (mode === 'supersede') current = false;
      if (excluded && index === 1) {
        // Leave a large skipped entry open while its remaining bytes fail to
        // download. Unlike regular files, it never gets a per-file pipeline.
        await delay(20);
        throw failure;
      }
      const part = parts[index];
      assert.ok(part);
      return part;
    },
  } as unknown as SandboxApiClient;
  try {
    let error: unknown;
    try {
      await exportSandboxWorkspace(
        client,
        'synthetic',
        '/workspace',
        staging,
        {
          signal: controller.signal,
          assertCurrent() {
            if (!current) throw new Error('synthetic superseded owner');
          },
        },
        undefined,
        excluded ? ['reports/raw'] : undefined,
      );
    } catch (caught) {
      error = caught;
    }
    if (mode === 'control') assert.equal(error, undefined);
    else {
      assert.ok(error instanceof Error, 'export must reject rather than silently succeed');
      if (mode === 'abort') assert.equal(error, controller.signal.reason);
      if (mode === 'supersede') assert.equal(error.message, 'synthetic superseded owner');
      if (mode === 'unsafe') assert.equal(error.message, 'Unsafe sandbox archive entry path');
      if (excluded) assert.equal(error, failure);
      assert.deepEqual(await readdir(staging), [], 'rejected entry must not write staging');
    }
    assert.equal(cleanupCount, 1, 'export must finish remote temporary-archive cleanup');
    console.log(JSON.stringify({ mode, outcome: mode === 'control' ? 'completed' : 'rejected' }));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
