import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ArtifactExports } from '../../managed/artifact-exports.js';
import type { ArtifactStore } from '../../managed/artifact-store.js';
import { digest, sha256 } from '../../managed/canonical.js';

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
}
