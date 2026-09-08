import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthModule } from '../interfaces/auth-module.js';
import type { ArtifactStore } from './artifact-store.js';
import {
  type ManagedComponentsConfig,
  type managedComponents,
  registerManagedComponentRoutes,
  registerManagedRoutes,
} from './bootstrap.js';

export interface ManagedUserBinding {
  issuer: string;
  audience: string;
  objectId: string;
  installationId: string;
}

/** Reuses native Entra validation; never accepts pod tokens or caller installation headers. */
export function managedUserAuthenticator(
  auth: AuthModule,
  bindings: readonly ManagedUserBinding[],
) {
  const keys = bindings.map((b) => JSON.stringify([b.issuer, b.audience, b.objectId]));
  if (
    !bindings.length ||
    new Set(keys).size !== keys.length ||
    bindings.some(
      (b) =>
        !b.issuer.startsWith('https://') ||
        !b.audience ||
        !b.objectId ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(b.installationId),
    )
  ) {
    throw new Error('managed-user-binding-invalid');
  }
  return async (request: FastifyRequest): Promise<string | null> => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ') || !header.slice(7)) return null;
    try {
      const user = await auth.validateToken(header.slice(7));
      if (!Number.isFinite(user.exp) || user.exp <= Date.now() / 1000) return null;
      // The reviewed managed binding is the delegation authority. Existing CLI
      // tokens need not carry app roles; native route role checks are unchanged.
      // Look up on every request, so removing a binding also revokes keep-alive requests.
      const matches = bindings.filter(
        (b) => b.issuer === user.iss && b.audience === user.aud && b.objectId === user.oid,
      );
      return matches.length === 1 ? (matches[0]?.installationId ?? null) : null;
    } catch {
      return null;
    }
  };
}

/** Mount on the existing authenticated HTTPS service; no listener/configuration change. */
export function registerManagedUserRoutes(
  app: FastifyInstance,
  config: ManagedComponentsConfig,
  auth: AuthModule,
  bindings: readonly ManagedUserBinding[],
) {
  return registerManagedRoutes(app, config, managedUserAuthenticator(auth, bindings));
}

/** Mount an existing runtime composition so API routes and worker gateways share one service. */
export function registerManagedUserComponentRoutes(
  app: FastifyInstance,
  components: ReturnType<typeof managedComponents>,
  db: Database.Database,
  store: ArtifactStore,
  auth: AuthModule,
  bindings: readonly ManagedUserBinding[],
) {
  return registerManagedComponentRoutes(
    app,
    components,
    db,
    store,
    managedUserAuthenticator(auth, bindings),
  );
}
