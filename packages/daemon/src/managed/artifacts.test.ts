import { readFileSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ArtifactManifest, ArtifactOutput } from '@autopod/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { managedArtifactRoutes } from '../api/routes/managed-artifacts.js';
import { collectOutput } from './artifact-collector.js';
import { ArtifactExports } from './artifact-exports.js';
import {
  AzureBlobArtifactStore,
  ManagedIdentityBlobTransport,
  MemoryArtifactStore,
  verifyBundle,
} from './artifact-store.js';
import { digest } from './canonical.js';

const output: ArtifactOutput = {
  mode: 'required',
  root: '/output',
  requiredPaths: ['research.md'],
  include: ['**/*'],
  exclude: [],
  limits: { maxFiles: 5, maxFileBytes: 10000, maxTotalBytes: 10000 },
  links: { allowHardlinks: false, allowSymlinks: false },
};
const binding = {
  podId: 'pod-one',
  dispatcherAttemptId: 'attempt-one',
  executionSpecDigest: `sha256:${'0'.repeat(64)}`,
};
const roots: string[] = [];
const databases: Database.Database[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) {
    await chmod(path.join(root, 'input'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'managed-artifacts-')));
  roots.push(root);
  const directory = path.join(root, 'output');
  await mkdir(directory);
  await writeFile(path.join(directory, 'research.md'), '# Research\n');
  const database = path.join(root, 'state.db');
  const db = new Database(database);
  databases.push(db);
  db.exec(
    readFileSync(
      new URL('../db/migrations/142_managed_artifact_exports.sql', import.meta.url),
      'utf8',
    ),
  );
  return { root, directory, db, database };
}

describe('managed artifacts', () => {
  it('normalizes bundles across attempts and freezes provenance across restart', async () => {
    const { directory, db, database } = await setup();
    const store = new MemoryArtifactStore();
    const exports = new ArtifactExports(db, store, () => 100);
    const receipt = await exports.export(binding, directory, output, true);
    const second = await exports.export(
      { ...binding, podId: 'pod-two', dispatcherAttemptId: 'attempt-two' },
      directory,
      output,
      true,
    );
    expect(second?.bundleSha256).toBe(receipt?.bundleSha256);
    expect(second?.manifestSha256).not.toBe(receipt?.manifestSha256);
    db.close();
    const restarted = new Database(database);
    databases.push(restarted);
    await rm(directory, { recursive: true });
    expect(
      await new ArtifactExports(restarted, store, () => 200).export(
        binding,
        directory,
        output,
        true,
      ),
    ).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain(directory);
  });
  it.each(['after-freeze', 'after-commit'] as const)(
    'recovers %s without another collection or agent run',
    async (fault) => {
      const { directory, db, database } = await setup();
      const store = new MemoryArtifactStore();
      await expect(
        new ArtifactExports(db, store, () => 100).export(binding, directory, output, true, fault),
      ).rejects.toThrow();
      const frozen = db
        .prepare('SELECT artifact_id,manifest_sha256,bundle_sha256 FROM artifact_exports')
        .get() as { artifact_id: string; manifest_sha256: string; bundle_sha256: string };
      db.close();
      const restarted = new Database(database);
      databases.push(restarted);
      await rm(directory, { recursive: true });
      const receipt = await new ArtifactExports(restarted, store, () => 900).export(
        binding,
        directory,
        output,
        true,
      );
      expect(receipt).toMatchObject({
        artifactId: frozen.artifact_id,
        manifestSha256: frozen.manifest_sha256,
        bundleSha256: frozen.bundle_sha256,
      });
    },
  );
  it('retries a transient upload with a fresh Blob store object after response loss', async () => {
    const { directory, db } = await setup();
    const objects = new Map<string, Buffer>();
    let fail = true;
    const transport = {
      async putIfAbsent(name: string, bytes: Buffer) {
        const prior = objects.get(name);
        if (prior && !prior.equals(bytes)) throw new Error('conflict');
        objects.set(name, bytes);
        if (fail) {
          fail = false;
          throw new Error('lost-response');
        }
      },
      async get(name: string) {
        const value = objects.get(name);
        if (!value) throw new Error('missing');
        return value;
      },
    };
    const locate = async (id: string) => `managed-pods/pod-one/${id}`;
    await expect(
      new ArtifactExports(db, new AzureBlobArtifactStore(transport, locate)).export(
        binding,
        directory,
        output,
        true,
      ),
    ).rejects.toThrow('artifact-export-retryable');
    await rm(directory, { recursive: true });
    const receipt = await new ArtifactExports(
      db,
      new AzureBlobArtifactStore(transport, locate),
    ).export(binding, directory, output, true);
    expect(receipt?.status).toBe('committed');
    expect(objects.size).toBe(2);
  });
  it.each(['symlink', 'hardlink', 'fifo'] as const)(
    'rejects unsafe %s even if excluded',
    async (kind) => {
      const { directory } = await setup();
      const unsafe = path.join(directory, 'unsafe');
      if (kind === 'symlink') await symlink('research.md', unsafe);
      if (kind === 'hardlink') await link(path.join(directory, 'research.md'), unsafe);
      if (kind === 'fifo') {
        const { execFileSync } = await import('node:child_process');
        execFileSync('/usr/bin/mkfifo', [unsafe]);
      }
      await expect(collectOutput(directory, { ...output, exclude: ['unsafe'] })).rejects.toThrow(
        'artifact-unsafe-entry',
      );
    },
  );
  it('enforces required paths, count/byte limits, active-writer exclusion and optional empty output', async () => {
    const { directory, db } = await setup();
    await expect(
      new ArtifactExports(db, new MemoryArtifactStore()).export(binding, directory, output, false),
    ).rejects.toThrow('writer-still-active');
    await expect(
      collectOutput(directory, { ...output, requiredPaths: ['missing'] }),
    ).rejects.toThrow('required-path-missing');
    for (const key of ['maxFiles', 'maxFileBytes', 'maxTotalBytes'] as const) {
      await expect(
        collectOutput(directory, { ...output, limits: { ...output.limits, [key]: 0 } }),
      ).rejects.toThrow('limit');
    }
    await rm(path.join(directory, 'research.md'));
    await expect(collectOutput(directory, { ...output, requiredPaths: [] })).rejects.toThrow(
      'required-empty',
    );
    expect(
      await collectOutput(directory, { ...output, mode: 'optional', requiredPaths: [] }),
    ).toBeNull();
  });
  it('verifies digest-pinned input bytes and installs files read-only', async () => {
    const { root, directory, db } = await setup();
    const store = new MemoryArtifactStore();
    const receipt = (await new ArtifactExports(db, store).export(
      binding,
      directory,
      output,
      true,
    ))!;
    const input = {
      name: 'research',
      backendArtifactId: receipt.artifactId,
      manifestSha256: receipt.manifestSha256,
      mountPath: '/inputs/research',
      access: 'read' as const,
    };
    await expect(
      store.materializeInput(
        { ...input, manifestSha256: `sha256:${'f'.repeat(64)}` },
        path.join(root, 'bad'),
      ),
    ).rejects.toThrow('digest-mismatch');
    const dest = path.join(root, 'input');
    await store.materializeInput(input, dest);
    expect(await readFile(path.join(dest, 'research.md'), 'utf8')).toBe('# Research\n');
    expect((await lstat(path.join(dest, 'research.md'))).mode & 0o222).toBe(0);
    await expect(store.materializeInput(input, dest)).rejects.toThrow('destination-exists');
    const manifest = await store.getManifest(receipt.artifactId);
    const bundle = (await store.createDownload(receipt.artifactId)).bytes;
    await expect(verifyBundle(manifest, Buffer.from('tampered'))).rejects.toThrow('integrity');
    const changed: ArtifactManifest = {
      ...manifest,
      files: [{ ...manifest.files[0]!, path: '../outside' }],
    };
    await expect(verifyBundle(changed, bundle)).rejects.toThrow('artifact-invalid-manifest');
    expect(digest(manifest)).toBe(receipt.manifestSha256);
  });
  it('authenticates metadata, manifest and streaming download without exposing storage credentials', async () => {
    const { directory, db } = await setup();
    const store = new MemoryArtifactStore();
    const exports = new ArtifactExports(db, store);
    const receipt = (await exports.export(binding, directory, output, true))!;
    const app = Fastify();
    managedArtifactRoutes(app, {
      exports,
      store,
      authorize: async (request) => request.headers['x-fixture-identity'] === 'installation-one',
    });
    for (const suffix of ['', '/manifest', '/download']) {
      const method = suffix === '/download' ? 'POST' : 'GET';
      const url = `/artifacts/${receipt.artifactId}${suffix}`;
      expect((await app.inject({ method, url })).statusCode).toBe(404);
      const result = await app.inject({
        method,
        url,
        headers: { 'x-fixture-identity': 'installation-one' },
      });
      expect(result.statusCode).toBe(200);
      if (suffix !== '/download') expect(result.body).not.toContain(directory);
    }
    await app.close();
    expect(
      () => new ManagedIdentityBlobTransport('https://example.test/private?sig=synthetic'),
    ).toThrow('invalid-private-blob-binding');
  });
});
