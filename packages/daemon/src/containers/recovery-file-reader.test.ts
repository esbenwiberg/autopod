import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  parseRecoveryContent,
  parseRecoveryListing,
  recoveryReaderArgs,
  runHostRecoveryReader,
} from './recovery-file-reader.js';

const roots: string[] = [];
async function root() {
  const p = await mkdtemp(join(tmpdir(), 'recovery-read-'));
  roots.push(p);
  return p;
}
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
const list = async (p: string) =>
  parseRecoveryListing(await runHostRecoveryReader(recoveryReaderArgs('list', p)));

it('lists source files of any extension and round-trips arbitrary binary bytes without writing the source', async () => {
  const p = await root();
  const bytes = Buffer.from([0, 255, 128, 10, 3]);
  await writeFile(join(p, 'source.weird'), bytes);
  const before = await list(p);
  const entry = before.files[0]!;
  expect(entry.path).toBe('source.weird');
  const value = parseRecoveryContent(
    await runHostRecoveryReader(recoveryReaderArgs('read', p, entry.path, entry.version)),
    entry.path,
  );
  expect(Buffer.from(value.content, 'base64')).toEqual(bytes);
  expect(await list(p)).toEqual(before);
});
it('refuses stale versions and changed roots', async () => {
  const p = await root();
  await writeFile(join(p, 'a'), 'before');
  const [entry] = (await list(p)).files;
  await writeFile(join(p, 'a'), 'after');
  await expect(
    runHostRecoveryReader(recoveryReaderArgs('read', p, 'a', entry!.version)),
  ).rejects.toThrow();
  await expect(
    runHostRecoveryReader(recoveryReaderArgs('list', p, '', '', 'wrong-root')),
  ).rejects.toThrow();
});
it('never follows final/intermediate/root symlinks, hardlinks or common credential locations', async () => {
  const p = await root(),
    outside = await root();
  await writeFile(join(outside, 'secret'), 'do not expose');
  await symlink(outside, join(p, 'escape'));
  await symlink(join(outside, 'secret'), join(p, 'link'));
  await link(join(outside, 'secret'), join(p, 'hard'));
  await writeFile(join(p, '.env.production'), 'secret');
  await mkdir(join(p, '.git'));
  await writeFile(join(p, '.git', 'config'), 'secret');
  expect((await list(p)).files).toEqual([]);
  const digest = 'a'.repeat(64);
  for (const name of ['escape/secret', 'link', 'hard'])
    await expect(
      runHostRecoveryReader(recoveryReaderArgs('read', p, name, digest)),
    ).rejects.toThrow();
  expect(() => recoveryReaderArgs('read', p, '../secret', digest)).toThrow();
  const parent = await root();
  await symlink(p, join(parent, 'root'));
  await expect(list(join(parent, 'root'))).rejects.toThrow();
});
it('blocks an intermediate directory replaced by a symlink after listing', async () => {
  const p = await root(),
    outside = await root();
  await mkdir(join(p, 'nested'));
  await writeFile(join(p, 'nested', 'a'), 'original');
  const entry = (await list(p)).files[0]!;
  await rm(join(p, 'nested'), { recursive: true });
  await writeFile(join(outside, 'a'), 'secret');
  await symlink(outside, join(p, 'nested'));
  await expect(
    runHostRecoveryReader(recoveryReaderArgs('read', p, entry.path, entry.version)),
  ).rejects.toThrow();
});
it('reports omitted oversized files and depth truncation rather than promising complete preservation', async () => {
  const p = await root();
  await writeFile(join(p, 'large'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await mkdir(join(p, ...Array(18).fill('nested')), { recursive: true });
  const result = await list(p);
  expect(result.truncated).toBe(true);
  expect(result.skippedEntries).toBeGreaterThan(0);
  expect(result.files).toEqual([]);
});
it('rejects forged/corrupt binary responses and unsafe paths', () => {
  expect(() =>
    parseRecoveryContent(
      JSON.stringify({
        path: 'a',
        content: 'AA==',
        encoding: 'base64',
        size: 1,
        sha256: 'a'.repeat(64),
      }),
      'a',
    ),
  ).toThrow();
  for (const p of ['/root', '../a', 'a/../b', 'a\\b', 'a\nb', '.env', '.ssh/key', 'a//b'])
    expect(() => recoveryReaderArgs('read', '/', p, 'a'.repeat(64))).toThrow();
});
