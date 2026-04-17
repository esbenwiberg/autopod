import { AuthError } from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PodTokenIssuer } from '../../crypto/pod-tokens.js';
import type { AuthModule } from '../../interfaces/index.js';

/**
 * Route-level auth config:
 *  - `auth: false`           — no auth required
 *  - `auth: 'pod-token'` — accepts Bearer token OR ?token= pod-scoped query param
 *  - default (omitted)       — requires Bearer token
 */
export function authPlugin(
  app: FastifyInstance,
  authModule: AuthModule,
  sessionTokenIssuer?: PodTokenIssuer,
): void {
  app.decorateRequest('user', null);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const routeConfig = request.routeOptions?.config as
      | { auth?: boolean | 'pod-token' }
      | undefined;

    // Skip auth entirely
    if (routeConfig?.auth === false) return;

    // Pod-token mode: accept HMAC pod token (Bearer or ?token=) or regular user token.
    // Containers use HMAC tokens issued by sessionTokenIssuer; human callers use Entra tokens.
    if (routeConfig?.auth === 'pod-token') {
      const routeSessionId = (request.params as Record<string, string>)?.podId;

      // Extract token from Bearer header or ?token= query param
      const authHeader = request.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const queryToken = (request.query as Record<string, string>)?.token;
      const token = bearerToken ?? queryToken;

      if (!token) {
        throw new AuthError('Missing or invalid Authorization header');
      }

      // Try pod token (HMAC) first — this is the primary path for container MCP calls
      if (sessionTokenIssuer) {
        const podId = sessionTokenIssuer.verify(token);
        if (podId) {
          if (routeSessionId && routeSessionId !== podId) {
            throw new AuthError('Pod token does not match requested pod');
          }
          return; // Authenticated via pod token — no user object (anonymous access)
        }
      }

      // Fall back to regular user token (Entra) — for human callers hitting the endpoint
      try {
        request.user = await authModule.validateToken(token);
        return;
      } catch {
        throw new AuthError('Invalid pod token or authorization token');
      }
    }

    // Default: require Bearer token
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    request.user = await authModule.validateToken(token);
  });
}
