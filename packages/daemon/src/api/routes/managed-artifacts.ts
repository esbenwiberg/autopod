import type { FastifyInstance, FastifyRequest } from 'fastify';
import { safeRelative } from '../../managed/artifact-collector.js';
import type { ArtifactExports } from '../../managed/artifact-exports.js';
import { type ArtifactStore, verifyBundle } from '../../managed/artifact-store.js';
import { digest, sha256 } from '../../managed/canonical.js';

const MAX_PREVIEW_FILE_BYTES = 5 * 1024 * 1024;

export interface ManagedArtifactDeps {
  exports: ArtifactExports;
  store: ArtifactStore;
  /** Authenticated service identity plus artifact ownership; never caller-supplied identity. */
  authorize: (request: FastifyRequest, artifactId: string) => Promise<boolean>;
}
export function managedArtifactRoutes(app: FastifyInstance, deps: ManagedArtifactDeps): void {
  for (const kind of ['receipt', 'manifest', 'download'] as const) {
    const suffix = kind === 'receipt' ? '' : `/${kind}`;
    app.route<{ Params: { artifactId: string } }>({
      method: kind === 'download' ? 'POST' : 'GET',
      url: `/artifacts/:artifactId${suffix}`,
      bodyLimit: 1024,
      handler: async (request, reply) => {
        const id = request.params.artifactId;
        if (!/^[A-Za-z0-9-]{1,100}$/.test(id) || !(await deps.authorize(request, id))) {
          return reply.code(404).send({
            schemaVersion: 1,
            code: 'artifact-unavailable',
            retryable: false,
            requestId: request.id,
          });
        }
        try {
          const receipt = deps.exports.getReceipt(id);
          if (kind === 'receipt') return receipt;
          const manifest = await deps.store.getManifest(id);
          if (digest(manifest) !== receipt.manifestSha256)
            throw new Error('artifact-integrity-failure');
          if (kind === 'manifest') return manifest;
          const download = await deps.store.createDownload(id);
          if (sha256(download.bytes) !== receipt.bundleSha256)
            throw new Error('artifact-integrity-failure');
          return reply.type(download.contentType).send(download.bytes);
        } catch {
          return reply.code(409).send({
            schemaVersion: 1,
            code: 'artifact-unavailable',
            retryable: true,
            requestId: request.id,
          });
        }
      },
    });
  }

  app.route<{
    Params: { artifactId: string };
    Querystring: { path?: string };
  }>({
    method: 'GET',
    url: '/artifacts/:artifactId/files/content',
    bodyLimit: 1024,
    handler: async (request, reply) => {
      const id = request.params.artifactId;
      if (!/^[A-Za-z0-9-]{1,100}$/.test(id) || !(await deps.authorize(request, id))) {
        return reply.code(404).send({
          schemaVersion: 1,
          code: 'artifact-unavailable',
          retryable: false,
          requestId: request.id,
        });
      }

      const requestedPath = request.query.path;
      if (!requestedPath || !safeRelative(requestedPath)) {
        return reply.code(400).send({
          schemaVersion: 1,
          code: 'artifact-file-path-invalid',
          retryable: false,
          requestId: request.id,
        });
      }

      try {
        const receipt = deps.exports.getReceipt(id);
        const manifest = await deps.store.getManifest(id);
        if (digest(manifest) !== receipt.manifestSha256)
          throw new Error('artifact-integrity-failure');

        const file = manifest.files.find((candidate) => candidate.path === requestedPath);
        if (!file) {
          return reply.code(404).send({
            schemaVersion: 1,
            code: 'artifact-file-unavailable',
            retryable: false,
            requestId: request.id,
          });
        }
        if (file.size > MAX_PREVIEW_FILE_BYTES) {
          return reply.code(413).send({
            schemaVersion: 1,
            code: 'artifact-file-too-large',
            retryable: false,
            requestId: request.id,
          });
        }

        const download = await deps.store.createDownload(id);
        if (sha256(download.bytes) !== receipt.bundleSha256)
          throw new Error('artifact-integrity-failure');
        const bytes = (await verifyBundle(manifest, download.bytes)).get(requestedPath);
        if (!bytes) throw new Error('artifact-file-unavailable');
        return reply.type('application/octet-stream').send(bytes);
      } catch {
        return reply.code(409).send({
          schemaVersion: 1,
          code: 'artifact-unavailable',
          retryable: true,
          requestId: request.id,
        });
      }
    },
  });
}
