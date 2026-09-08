import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  type ArtifactInput,
  type ArtifactManifest,
  ArtifactManifestSchema,
  type ArtifactReceipt,
  ArtifactReceiptSchema,
} from '@autopod/shared';
import { ManagedIdentityCredential } from '@azure/identity';
import tar from 'tar-stream';
import { safeRelative } from './artifact-collector.js';
import { canonical, digest, sha256 } from './canonical.js';

export interface ArtifactCommitInput {
  manifest: ArtifactManifest;
  bundle: Buffer;
}
export interface ArtifactDownload {
  bytes: Buffer;
  contentType: 'application/gzip';
}
export interface ArtifactStore {
  commit(input: ArtifactCommitInput): Promise<ArtifactReceipt>;
  getManifest(artifactId: string): Promise<ArtifactManifest>;
  createDownload(artifactId: string): Promise<ArtifactDownload>;
  materializeInput(input: ArtifactInput, destination: string): Promise<void>;
}

export function receiptFor(manifest: ArtifactManifest): ArtifactReceipt {
  return ArtifactReceiptSchema.parse({
    schemaVersion: 1,
    artifactId: manifest.artifactId,
    podId: manifest.podId,
    dispatcherAttemptId: manifest.dispatcherAttemptId,
    executionSpecDigest: manifest.executionSpecDigest,
    manifestSha256: digest(manifest),
    bundleSha256: manifest.bundle.sha256,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    status: 'committed',
  });
}

export async function verifyBundle(
  manifest: ArtifactManifest,
  bundle: Buffer,
): Promise<Map<string, Buffer>> {
  if (!ArtifactManifestSchema.safeParse(manifest).success)
    throw new Error('artifact-invalid-manifest');
  if (
    manifest.bundle.sha256 !== sha256(bundle) ||
    manifest.bundle.size !== bundle.length ||
    manifest.files.length !== manifest.fileCount ||
    manifest.files.reduce((sum, file) => sum + file.size, 0) !== manifest.totalBytes
  ) {
    throw new Error('artifact-integrity-failure');
  }
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (
    expected.size !== manifest.files.length ||
    manifest.files.some((file) => !safeRelative(file.path))
  ) {
    throw new Error('artifact-unsafe-manifest');
  }
  const result = new Map<string, Buffer>();
  const extract = tar.extract();
  const completed = new Promise<void>((resolve, reject) => {
    extract.on('error', reject);
    extract.on('finish', resolve);
    extract.on('entry', (header, stream, next) => {
      const file = expected.get(header.name);
      if (
        header.type !== 'file' ||
        !safeRelative(header.name) ||
        !file ||
        result.has(header.name) ||
        header.size !== file.size ||
        header.linkname
      ) {
        stream.resume();
        extract.destroy(new Error('artifact-unsafe-entry'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > file.size) {
          extract.destroy(new Error('artifact-size-mismatch'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.on('error', reject);
      stream.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (size !== file.size || sha256(bytes) !== file.sha256) {
          extract.destroy(new Error('artifact-integrity-failure'));
          return;
        }
        result.set(header.name, bytes);
        next();
      });
    });
  });
  let archive: Buffer;
  try {
    archive = gunzipSync(bundle, {
      maxOutputLength: manifest.totalBytes + (manifest.fileCount * 3 + 4) * 512,
    });
  } catch {
    throw new Error('artifact-invalid-bundle');
  }
  extract.end(archive);
  await completed;
  if (result.size !== expected.size) throw new Error('artifact-files-missing');
  return result;
}

async function materialize(
  store: ArtifactStore,
  input: ArtifactInput,
  destination: string,
): Promise<void> {
  const manifest = await store.getManifest(input.backendArtifactId);
  if (
    digest(manifest) !== input.manifestSha256 ||
    manifest.artifactId !== input.backendArtifactId ||
    input.access !== 'read'
  ) {
    throw new Error('artifact-input-digest-mismatch');
  }
  const files = await verifyBundle(
    manifest,
    (await store.createDownload(input.backendArtifactId)).bytes,
  );
  let ancestor = path.resolve(path.dirname(destination));
  while (ancestor !== path.dirname(ancestor)) {
    const stat = await lstat(ancestor);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('artifact-unsafe-destination');
    ancestor = path.dirname(ancestor);
  }
  try {
    await lstat(destination);
    throw new Error('artifact-input-destination-exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = `${destination}.${randomUUID()}.staging`;
  await mkdir(staging, { mode: 0o700 });
  const directories = new Set([staging]);
  try {
    for (const [name, bytes] of files) {
      const file = path.join(staging, name);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      let parent = path.dirname(file);
      while (parent.startsWith(staging)) {
        directories.add(parent);
        if (parent === staging) break;
        parent = path.dirname(parent);
      }
      await writeFile(file, bytes, { flag: 'wx', mode: 0o444 });
    }
    // The runtime must additionally mount this tree read-only; modes alone are not isolation.
    for (const directory of [...directories].sort().reverse()) await chmod(directory, 0o555);
    await rename(staging, destination);
  } catch (error) {
    for (const directory of directories) await chmod(directory, 0o700).catch(() => {});
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, ArtifactCommitInput>();
  async commit(input: ArtifactCommitInput): Promise<ArtifactReceipt> {
    await verifyBundle(input.manifest, input.bundle);
    const prior = this.objects.get(input.manifest.artifactId);
    if (
      prior &&
      (digest(prior.manifest) !== digest(input.manifest) || !prior.bundle.equals(input.bundle))
    ) {
      throw new Error('artifact-immutable-conflict');
    }
    this.objects.set(input.manifest.artifactId, {
      manifest: structuredClone(input.manifest),
      bundle: Buffer.from(input.bundle),
    });
    return receiptFor(input.manifest);
  }
  async getManifest(id: string): Promise<ArtifactManifest> {
    const value = this.objects.get(id);
    if (!value) throw new Error('artifact-not-found');
    return structuredClone(value.manifest);
  }
  async createDownload(id: string): Promise<ArtifactDownload> {
    const value = this.objects.get(id);
    if (!value) throw new Error('artifact-not-found');
    return { bytes: Buffer.from(value.bundle), contentType: 'application/gzip' };
  }
  materializeInput(input: ArtifactInput, destination: string): Promise<void> {
    return materialize(this, input, destination);
  }
}

export interface BlobTransport {
  putIfAbsent(name: string, bytes: Buffer): Promise<void>;
  get(name: string): Promise<Buffer>;
}

/** Private Azure Blob REST transport. Only the VM managed identity can authenticate. */
export class ManagedIdentityBlobTransport implements BlobTransport {
  constructor(
    private readonly containerUrl: string,
    private readonly credential = new ManagedIdentityCredential(),
    private readonly request: typeof fetch = fetch,
  ) {
    const url = new URL(containerUrl);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.blob.core.windows.net') ||
      url.search ||
      url.username ||
      url.password ||
      !/^\/[a-z0-9-]+$/.test(url.pathname)
    ) {
      throw new Error('invalid-private-blob-binding');
    }
  }
  private async call(method: string, name: string, bytes?: Buffer): Promise<Response> {
    if (!safeRelative(name)) throw new Error('artifact-unsafe-object-name');
    const token = await this.credential.getToken('https://storage.azure.com/.default');
    const response = await this.request(`${this.containerUrl}/${name}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token.token}`,
        'x-ms-version': '2023-11-03',
        'x-ms-date': new Date().toUTCString(),
        ...(method === 'PUT' ? { 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*' } : {}),
      },
      ...(bytes ? { body: new Uint8Array(bytes) } : {}),
    });
    return response;
  }
  async putIfAbsent(name: string, bytes: Buffer): Promise<void> {
    const response = await this.call('PUT', name, bytes);
    if (
      response.status === 412 ||
      (response.status === 409 && response.headers.get('x-ms-error-code') === 'BlobAlreadyExists')
    ) {
      if (!(await this.get(name)).equals(bytes)) throw new Error('artifact-immutable-conflict');
    } else if (!response.ok) throw new Error('artifact-store-unavailable');
  }
  async get(name: string): Promise<Buffer> {
    const response = await this.call('GET', name);
    if (!response.ok) throw new Error('artifact-store-unavailable');
    return Buffer.from(await response.arrayBuffer());
  }
}

export class AzureBlobArtifactStore implements ArtifactStore {
  // Artifact IDs encode the immutable pod/artifact key; the caller supplies a trusted lookup.
  constructor(
    private readonly transport: BlobTransport,
    private readonly locate: (artifactId: string) => Promise<string>,
  ) {}
  async commit(input: ArtifactCommitInput): Promise<ArtifactReceipt> {
    await verifyBundle(input.manifest, input.bundle);
    const prefix = await this.locate(input.manifest.artifactId);
    await this.transport.putIfAbsent(`${prefix}/bundle.tar.gz`, input.bundle);
    await this.transport.putIfAbsent(
      `${prefix}/manifest.json`,
      Buffer.from(canonical(input.manifest)),
    );
    return receiptFor(input.manifest);
  }
  async getManifest(id: string): Promise<ArtifactManifest> {
    let value: unknown;
    try {
      value = JSON.parse(
        (await this.transport.get(`${await this.locate(id)}/manifest.json`)).toString('utf8'),
      );
    } catch {
      throw new Error('artifact-manifest-unavailable');
    }
    const parsed = ArtifactManifestSchema.safeParse(value);
    if (!parsed.success || parsed.data.artifactId !== id)
      throw new Error('artifact-invalid-manifest');
    return parsed.data;
  }
  async createDownload(id: string): Promise<ArtifactDownload> {
    return {
      bytes: await this.transport.get(`${await this.locate(id)}/bundle.tar.gz`),
      contentType: 'application/gzip',
    };
  }
  materializeInput(input: ArtifactInput, destination: string): Promise<void> {
    return materialize(this, input, destination);
  }
}
