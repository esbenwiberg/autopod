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
  app.decorateRequest('user', null as any);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const routeConfig = request.routeOptions?.config as
      | { auth?: boolean | 'session-token' }
      | undefined;

    // Skip auth entirely
    if (routeConfig?.auth === false) return;

    // Session-token mode: accept either Bearer or ?token= query param
    if (routeConfig?.auth === 'session-token') {
      // Try Bearer first
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        request.user = await authModule.validateToken(token);
        return;
      }

      // Fall back to ?token= query param
      const queryToken = (request.query as Record<string, string>)?.token;
      if (queryToken && sessionTokenIssuer) {
        const sessionId = sessionTokenIssuer.verify(queryToken);
        if (!sessionId) {
          throw new AuthError('Invalid or expired session token');
        }

        // Verify the token's session matches the route's :sessionId param
        const routeSessionId = (request.params as Record<string, string>)?.sessionId;
        if (routeSessionId && routeSessionId !== sessionId) {
          throw new AuthError('Session token does not match requested session');
        }
        return; // Authenticated via session token — no user object (anonymous access)
      }

      throw new AuthError('Missing or invalid Authorization header');
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
