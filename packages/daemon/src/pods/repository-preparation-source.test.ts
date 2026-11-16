import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEGRATION_TEST_TIMEOUT_MS } from '../test-utils/test-budgets.js';
import { PREPARATION_SOURCE_PROBE } from './repository-preparation.js';

const exec = promisify(execFile);
const roots: string[] = [];
const MiB = 1024 * 1024;
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function commit(root: string) {
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'preparation-source-'));
  roots.push(root);
  await exec('git', ['init', '-q', root]);
  await writeFile(path.join(root, 'lock.json'), 'first');
  await writeFile(path.join(root, 'prepare.sh'), 'echo ready');
  await commit(root);
  return root;
}

async function sparseFile(root: string, name: string, size: number) {
  const file = await open(path.join(root, name), 'w');
  try {
    await file.truncate(size);
  } finally {
    await file.close();
  }
}

async function probe(root: string, prelude = '') {
  const script = PREPARATION_SOURCE_PROBE.replace(
    "const root='/workspace'",
    `const root=${JSON.stringify(root)}`,
  );
  const result = await exec(process.execPath, ['-e', `${prelude}\n${script}`], { timeout: 15000 });
  return JSON.parse(result.stdout) as { head: string; fingerprint: string };
}

// Real Git and real file reads, under the production probe's unchanged 15-second exec bound.
// Fixture creation/commit and multiple probes get an explicit integration-test budget.
describe('native repository preparation source probe', () => {
  it('preserves existing fingerprint framing for unchanged source', async () => {
    const root = await fixture();
    const expected = createHash('sha256');
    for (const [name, content] of [
      ['lock.json', 'first'],
      ['prepare.sh', 'echo ready'],
    ] as const) {
      expected.update(JSON.stringify([name, 0, Buffer.byteLength(content)]));
      expected.update(content);
    }
    expect((await probe(root)).fingerprint).toBe(expected.digest('hex'));
    const before = await probe(root);
    await chmod(path.join(root, 'prepare.sh'), 0o755);
    expect((await probe(root)).fingerprint).not.toBe(before.fingerprint);
  });

  it(
    'hashes a large tracked checkout and detects edits beyond the old aggregate limit',
    async () => {
      const root = await fixture();
      for (let i = 0; i < 9; i++) await sparseFile(root, `chunk-${i}.bin`, 12 * MiB);
      await commit(root); // 108 MiB tracked, rather than ignored/generated installation output.
      const before = await probe(root);
      const file = await open(path.join(root, 'chunk-8.bin'), 'r+');
      try {
        await file.write(Buffer.from([1]), 0, 1, 12 * MiB - 1);
        expect((await probe(root)).fingerprint).not.toBe(before.fingerprint);
        await file.write(Buffer.from([0]), 0, 1, 12 * MiB - 1);
        expect(await probe(root)).toEqual(before);
      } finally {
        await file.close();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    'streams a large individual file in bounded chunks and hashes its last byte',
    async () => {
      const root = await fixture();
      await sparseFile(root, 'large.bin', 20 * MiB + 31);
      await commit(root);
      const forbidWholeFileReads = `
const guardedFs=require('node:fs'), originalRead=guardedFs.readSync;
guardedFs.readFileSync=()=>{throw new Error('Whole-file reads forbidden');};
guardedFs.readSync=function(fd, buffer, offset, length, position){
 if(length>64*1024) throw new Error('Unbounded read');
 return originalRead.call(this, fd, buffer, offset, length, position);
};`;
      const before = await probe(root, forbidWholeFileReads);
      const file = await open(path.join(root, 'large.bin'), 'r+');
      try {
        await file.write(Buffer.from([1]), 0, 1, 20 * MiB + 30);
      } finally {
        await file.close();
      }
      expect((await probe(root, forbidWholeFileReads)).fingerprint).not.toBe(before.fingerprint);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it('still excludes ignored artifacts and includes new dependency inputs', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
    const before = await probe(root);
    await mkdir(path.join(root, 'ignored'));
    await sparseFile(root, 'ignored/output.bin', 128 * MiB);
    expect(await probe(root)).toEqual(before);
    await writeFile(path.join(root, 'new.lock'), 'new dependency');
    expect((await probe(root)).fingerprint).not.toBe(before.fingerprint);
  });

  it('hashes symlink targets without reading outside source', async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'preparation-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'input'), 'outside');
    await symlink(path.join(outside, 'input'), path.join(root, 'link'));
    const before = await probe(root);
    await writeFile(path.join(outside, 'input'), 'outside changed');
    expect(await probe(root)).toEqual(before);
    await unlink(path.join(root, 'link'));
    await symlink(path.join(outside, 'other'), path.join(root, 'link'));
    expect((await probe(root)).fingerprint).not.toBe(before.fingerprint);
  });

  it('rejects a tracked file whose parent now resolves outside the checkout', async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'preparation-outside-'));
    roots.push(outside);
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested/input'), 'inside');
    await commit(root);
    await rm(path.join(root, 'nested'), { recursive: true });
    await symlink(outside, path.join(root, 'nested'));
    await expect(probe(root)).rejects.toMatchObject({ code: 2 });
  });

  it('rejects non-regular tracked inputs without blocking on a FIFO', async () => {
    const root = await fixture();
    await unlink(path.join(root, 'lock.json'));
    await exec('mkfifo', [path.join(root, 'lock.json')]);
    await expect(probe(root)).rejects.toMatchObject({ code: 2 });
  });

  it('fails closed on early EOF instead of hashing a partial file', async () => {
    const root = await fixture();
    await expect(probe(root, "require('node:fs').readSync=()=>0;")).rejects.toMatchObject({
      code: 2,
    });
  });

  it('fails closed when a file changes during the read', async () => {
    const root = await fixture();
    const prelude = `
const changingFs=require('node:fs'), originalRead=changingFs.readSync;
changingFs.readSync=function(...args){
 const count=originalRead.apply(this,args);
 changingFs.truncateSync(${JSON.stringify(path.join(root, 'lock.json'))},0);
 return count;
};`;
    await expect(probe(root, prelude)).rejects.toMatchObject({ code: 2 });
  });

  it('retains an internal deadline in addition to the outer execution timeout', async () => {
    const root = await fixture();
    await expect(
      probe(root, 'let ticks=0; Date.now=()=>ticks++===0?0:12001;'),
    ).rejects.toMatchObject({ code: 2 });
  });
});
