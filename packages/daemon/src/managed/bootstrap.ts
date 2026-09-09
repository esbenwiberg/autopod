import path from 'node:path';
import type { SecureContextOptions, TLSSocket } from 'node:tls';
import type Database from 'better-sqlite3';
import Fastify, { type FastifyRequest } from 'fastify';
import { managedArtifactRoutes } from '../api/routes/managed-artifacts.js';
import { managedPodRoutes } from '../api/routes/managed-pods.js';
import { ArtifactExports } from './artifact-exports.js';
import { ManagedArtifactInputs } from './artifact-inputs.js';
import { ManagedArtifactPipeline } from './artifact-pipeline.js';
import type { ArtifactStore } from './artifact-store.js';
import type { ManagedAdmission } from './grants.js';
import { ManagedControls } from './managed-controls.js';
import { ManagedPodService, type ManagedRuntimePort } from './managed-service.js';
import { ManagedSourceDelivery } from './source-delivery.js';
import type { DraftBroker, ManagedGitBroker } from './source-git.js';

export interface ManagedComponentsConfig {
  db: Database.Database;
  admission: ManagedAdmission;
  runtime: ManagedRuntimePort;
  store: ArtifactStore;
  stateRoot: string;
  /** Explicit reviewed enablement; omitting it always keeps starts dark. */
  enabled?: boolean;
  /** Capabilities proven by the selected reviewed runtime composition. */
  runtimeCapabilities?: readonly ('managed-agent-session-v1' | 'managed-github-read-v1')[];
  source?: {
    git: ManagedGitBroker;
    drafts?: DraftBroker;
    verifierIdentities: ReadonlyMap<string, string>;
  };
}
export function managedComponents(config: ManagedComponentsConfig) {
  const service = new ManagedPodService(
    config.db,
    config.admission,
    config.runtime,
    undefined,
    config.enabled ?? false,
    config.runtimeCapabilities ?? [],
  );
  const controls = new ManagedControls(service);
  const exports = new ArtifactExports(config.db, config.store);
  service.inputs = new ManagedArtifactInputs(
    config.db,
    config.store,
    path.join(config.stateRoot, 'inputs'),
  );
  if (config.source)
    service.source = new ManagedSourceDelivery(
      service,
      config.source.git,
      config.source.verifierIdentities,
      config.source.drafts,
    );
  const pipeline = new ManagedArtifactPipeline(
    service,
    exports,
    path.join(config.stateRoot, 'staging'),
    controls,
  );
  return { service, controls, exports, pipeline };
}

export function servicePrincipal(
  request: FastifyRequest,
  principals: ReadonlyMap<string, string>,
): string | null {
  const socket = request.raw.socket as TLSSocket;
  if (!socket.encrypted || !socket.authorized || typeof socket.getPeerCertificate !== 'function')
    return null;
  const fingerprint = socket.getPeerCertificate().fingerprint256;
  return fingerprint ? (principals.get(fingerprint) ?? null) : null;
}

/** Private mTLS listener, separate from native user/pod-token routes. Does not listen or deploy. */
export function createManagedServer(
  config: ManagedComponentsConfig,
  tls: SecureContextOptions,
  principals: ReadonlyMap<string, string>,
) {
  if (!tls.cert || !tls.key || !tls.ca || principals.size === 0)
    throw new Error('managed-service-tls-required');
  const app = Fastify({
    logger: false,
    https: { ...tls, requestCert: true, rejectUnauthorized: true },
    bodyLimit: 1024 * 1024,
  });
  return {
    app,
    ...registerManagedRoutes(app, config, async (request) => servicePrincipal(request, principals)),
  };
}

export function registerManagedRoutes(
  app: import('fastify').FastifyInstance,
  config: ManagedComponentsConfig,
  authenticate: (request: FastifyRequest) => Promise<string | null>,
) {
  const components = managedComponents(config);
  registerManagedComponentRoutes(app, components, config, authenticate);
  return components;
}

export function registerManagedComponentRoutes(
  app: import('fastify').FastifyInstance,
  components: ReturnType<typeof managedComponents>,
  config: Pick<ManagedComponentsConfig, 'db' | 'store'>,
  authenticate: (request: FastifyRequest) => Promise<string | null>,
) {
  managedPodRoutes(app, {
    service: components.service,
    authenticate,
    finishOutputs: () => components.pipeline.tick(),
  });
  managedArtifactRoutes(app, {
    exports: components.exports,
    store: config.store,
    authorize: async (request, id) => {
      const installation = await authenticate(request);
      if (!installation) return false;
      return !!config.db
        .prepare(`SELECT 1 FROM artifact_exports JOIN managed_pods USING(pod_id)
      WHERE artifact_id=? AND dispatcher_installation_id=?`)
        .get(id, installation);
    },
  });
  return components;
}
