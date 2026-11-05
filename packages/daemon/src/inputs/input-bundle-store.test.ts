import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { InputBundleStore } from './input-bundle-store.js';

const databases: ReturnType<typeof createTestDb>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});
function fixture() {
  const db = createTestDb();
  databases.push(db);
  const store = new InputBundleStore(db);
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxN8AAAAASUVORK5CYII=',
    'base64',
  );
  const files = [
    {
      path: 'design/wireframe.png',
      mediaType: 'image/png',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ];
  const request = { requestKey: randomUUID(), files };
  const bundle = store.create(request, 'owner');
  return { db, store, bytes, request, bundle };
}
describe('immutable input bundles', () => {
  it('preserves exact binary bytes, owner isolation and idempotent upload identities', () => {
    const f = fixture();
    expect(f.store.create(f.request, 'owner').id).toBe(f.bundle.id);
    expect(() => f.store.get(f.bundle.id, 'other')).toThrow('not found');
    expect(() => f.store.assert(f.bundle, 'owner')).toThrow('Seal reference');
    expect(() => f.store.seal(f.bundle.id, 'owner')).toThrow('incomplete');
    expect(() => f.store.put(f.bundle.id, 'owner', 0, Buffer.from('bad'))).toThrow('manifest');
    f.store.put(f.bundle.id, 'owner', 0, f.bytes);
    const sealed = f.store.seal(f.bundle.id, 'owner');
    f.store.put(f.bundle.id, 'owner', 0, f.bytes);
    expect(f.store.read(sealed.id, 'owner', 0)).toEqual(f.bytes);
    const { status: _, ...ref } = sealed;
    expect(() => f.store.assert(ref, 'owner')).not.toThrow();
    expect(() => f.store.assert({ ...ref, digest: '0'.repeat(64) }, 'owner')).toThrow('changed');
    expect(() =>
      f.store.create(
        { ...f.request, files: [{ ...f.request.files[0], path: 'other.png' }] },
        'owner',
      ),
    ).toThrow('different inputs');
    expect(new InputBundleStore(f.db).read(sealed.id, 'owner', 0)).toEqual(f.bytes);
  });
  it('materializes original bytes outside source and refuses altered copies', async () => {
    const f = fixture();
    f.store.put(f.bundle.id, 'owner', 0, f.bytes);
    const { status: _, ...ref } = f.store.seal(f.bundle.id, 'owner');
    const root = await mkdtemp(path.join(os.tmpdir(), 'input-bundle-'));
    directories.push(root);
    const materialized = await f.store.materialize(ref, 'owner', root);
    expect(materialized).toBe(path.join(root, 'inputs', ref.id));
    expect(await readFile(path.join(materialized, 'files/design/wireframe.png'))).toEqual(f.bytes);
    expect(JSON.parse(await readFile(path.join(materialized, 'manifest.json'), 'utf8'))).toEqual(
      ref,
    );
    expect(await f.store.materialize(ref, 'owner', root)).toBe(materialized);
    await writeFile(path.join(materialized, 'manifest.json'), '{}', { mode: 0o644 }).catch(
      async () => {
        const { chmod } = await import('node:fs/promises');
        await chmod(path.join(materialized, 'manifest.json'), 0o644);
        await writeFile(path.join(materialized, 'manifest.json'), '{}');
      },
    );
    await expect(f.store.materialize(ref, 'owner', root)).rejects.toThrow('manifest copy changed');
  });
  it('keeps pinned originals through retention and collects abandoned uploads only', () => {
    const f = fixture();
    f.store.put(f.bundle.id, 'owner', 0, f.bytes);
    const { status: _, ...ref } = f.store.seal(f.bundle.id, 'owner');
    f.store.pin(ref, 'owner', 'deleted-parent');
    const orphan = f.store.create({ ...f.request, requestKey: randomUUID() }, 'owner');
    expect(f.store.sweep(Date.now() + 8 * 24 * 3600_000)).toBe(1);
    expect(() => f.store.get(orphan.id, 'owner')).toThrow('not found');
    expect(f.store.read(ref.id, 'owner', 0)).toEqual(f.bytes);
  });
  it('restores manifest and exact original bytes from the existing SQLite backup format', async () => {
    const f = fixture();
    f.store.put(f.bundle.id, 'owner', 0, f.bytes);
    const { status: _, ...ref } = f.store.seal(f.bundle.id, 'owner');
    f.store.pin(ref, 'owner', 'retained-pod');
    const root = await mkdtemp(path.join(os.tmpdir(), 'input-backup-'));
    directories.push(root);
    const backup = path.join(root, 'backup.db');
    await f.db.backup(backup);
    const restored = new Database(backup);
    databases.push(restored);
    const store = new InputBundleStore(restored);
    expect(store.read(ref.id, 'owner', 0)).toEqual(f.bytes);
    const copy = await store.materialize(ref, 'owner', path.join(root, 'fresh-data'));
    expect(await readFile(path.join(copy, 'files/design/wireframe.png'))).toEqual(f.bytes);
    expect(store.sweep(Date.now() + 365 * 24 * 3600_000)).toBe(0);
  });

  it('validates file content and reserves quotas before accepting bytes', () => {
    const f = fixture();
    const bytes = Buffer.from('not a png');
    const bundle = f.store.create(
      {
        requestKey: randomUUID(),
        files: [
          {
            ...f.request.files[0],
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      'owner',
    );
    expect(() => f.store.put(bundle.id, 'owner', 0, bytes)).toThrow('file type');
    f.db
      .prepare('UPDATE input_bundles SET byte_length=? WHERE id=?')
      .run(250 * 1024 * 1024, f.bundle.id);
    expect(() => f.store.create({ ...f.request, requestKey: randomUUID() }, 'owner')).toThrow(
      'quota',
    );
  });
});
