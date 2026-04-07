import { AuthError } from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionTokenIssuer } from '../../crypto/session-tokens.js';
import type { AuthModule } from '../../interfaces/index.js';

/**
 * Route-level auth config:
 *  - `auth: false`           — no auth required
 *  - `auth: 'session-token'` — accepts Bearer token OR ?token= session-scoped query param
 *  - default (omitted)       — requires Bearer token
 */
export function authPlugin(
  app: FastifyInstance,
  authModule: AuthModule,
  sessionTokenIssuer?: SessionTokenIssuer,
): void {
  app.decorateRequest('user', null);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const routeConfig = request.routeOptions?.config as
      | { auth?: boolean | 'session-token' }
      | undefined;

    // Skip auth entirely
    if (routeConfig?.auth === false) return;

    // Session-token mode: accept HMAC session token (Bearer or ?token=) or regular user token.
    // Containers use HMAC tokens issued by sessionTokenIssuer; human callers use Entra tokens.
    if (routeConfig?.auth === 'session-token') {
      const routeSessionId = (request.params as Record<string, string>)?.sessionId;

      // Extract token from Bearer header or ?token= query param
      const authHeader = request.headers.authorization;
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      const queryToken = (request.query as Record<string, string>)?.token;
      const token = bearerToken ?? queryToken;

      if (!token) {
        throw new AuthError('Missing or invalid Authorization header');
      }

      // Try session token (HMAC) first — this is the primary path for container MCP calls
      if (sessionTokenIssuer) {
        const sessionId = sessionTokenIssuer.verify(token);
        if (sessionId) {
          if (routeSessionId && routeSessionId !== sessionId) {
            throw new AuthError('Session token does not match requested session');
          }
          return; // Authenticated via session token — no user object (anonymous access)
        }
      }

      // Fall back to regular user token (Entra) — for human callers hitting the endpoint
      try {
        request.user = await authModule.validateToken(token);
        return;
      } catch {
        throw new AuthError('Invalid session token or authorization token');
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
