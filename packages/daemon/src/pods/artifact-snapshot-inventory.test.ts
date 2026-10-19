import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  verifyArtifactSnapshot,
  writeArtifactSnapshotReceipt,
} from './artifact-snapshot-receipt.js';

// Model the observed Portfolio shape without making a CI filesystem create
// 100,227 entries. Receipt publication and reads still use the real filesystem.
const fixture = vi.hoisted(() => ({ root: '', files: 95_401, directories: 4_775, links: 50 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: async (name: string) => {
      if (name !== fixture.root && !name.startsWith(`${fixture.root}/`)) return real.lstat(name);
      const leaf = name.slice(fixture.root.length + 1);
      const directory = name === fixture.root || leaf.startsWith('directory-');
      const link = leaf.startsWith('link-');
      return {
        mode: directory ? 0o40755 : link ? 0o120777 : 0o100644,
        size: 0,
        ino: 1,
        dev: 1,
        mtimeMs: 0,
        ctimeMs: 0,
        isDirectory: () => directory,
        isSymbolicLink: () => link,
        isFile: () => !directory && !link,
      };
    },
    readdir: async (name: string) => {
      if (name === fixture.root)
        return [
          ...Array.from({ length: fixture.files }, (_, i) => `file-${i}`),
          ...Array.from({ length: fixture.directories }, (_, i) => `directory-${i}`),
          ...Array.from({ length: fixture.links }, (_, i) => `link-${i}`),
        ];
      if (name.startsWith(`${fixture.root}/directory-`)) return [];
      return real.readdir(name);
    },
    readlink: async (name: string) =>
      name.startsWith(`${fixture.root}/link-`) ? '/unavailable/reference' : real.readlink(name),
    open: async (
      name: string,
      ...args: Parameters<typeof real.open> extends [unknown, ...infer Rest] ? Rest : never
    ) => {
      if (!name.startsWith(`${fixture.root}/file-`)) return real.open(name, ...args);
      return {
        stat: async () => ({ ino: 1, dev: 1, size: 0, mtimeMs: 0, ctimeMs: 0 }),
        createReadStream: async function* () {},
        close: async () => {},
      };
    },
  };
});

let directory: string;
afterEach(async () => {
  fixture.root = '';
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function setup(files: number, directories: number, links = 0) {
  directory = await mkdtemp(path.join(tmpdir(), 'inventory-shape-'));
  fixture.root = path.join(directory, 'generation-1-00000000-0000-0000-0000-000000000000');
  Object.assign(fixture, { files, directories, links });
  return fixture.root;
}

describe('bounded full workspace inventory shape', () => {
  it('preserves the observed Portfolio files, directories and links without exclusions', async () => {
    const snapshot = await setup(95_401, 4_775, 50);
    await writeArtifactSnapshotReceipt(snapshot, snapshot, 1, 0);
    const receipt = JSON.parse(await readFile(`${snapshot}.receipt.json`, 'utf8'));
    expect(receipt.entries).toBe(100_227);
    await expect(verifyArtifactSnapshot(snapshot, directory, 1)).resolves.toBeUndefined();
    fixture.files++;
    await expect(verifyArtifactSnapshot(snapshot, directory, 1)).rejects.toMatchObject({
      code: 'ARTIFACT_SNAPSHOT_UNVERIFIED',
    });
  });

  it('still rejects more than 100000 file or link entries before publishing', async () => {
    const snapshot = await setup(100_000, 0, 1);
    await expect(writeArtifactSnapshotReceipt(snapshot, snapshot, 1, 0)).rejects.toThrow();
    await expect(readFile(`${snapshot}.receipt.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds directory-only trees separately before publishing', async () => {
    const snapshot = await setup(0, 100_000);
    await expect(writeArtifactSnapshotReceipt(snapshot, snapshot, 1, 0)).rejects.toThrow();
    await expect(readFile(`${snapshot}.receipt.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
