import { AuthError } from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PodTokenIssuer } from '../../crypto/pod-tokens.js';
import type { AuthModule } from '../../interfaces/index.js';

/**
 * Route-level auth config:
 *  - `auth: false`           — no auth required
 *  - `auth: 'pod-token'` — accepts Bearer pod-scoped HMAC token or regular user Bearer token
 *  - default (omitted)       — requires Bearer token
 *
 * Note: ?token= query-param auth is NOT supported here. Routes that require browser-initiated
 * access (e.g. the report page GET) use `auth: false` and validate manually so they can
 * restrict to pod HMAC tokens and avoid exposing user tokens in URLs.
 */
export function authPlugin(
  app: FastifyInstance,
  authModule: AuthModule,
  sessionTokenIssuer?: PodTokenIssuer,
): void {
  app.decorateRequest('user', null);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    // The mobile PWA shell (HTML, JS, manifest, icons) is public by design —
    // it's the same bundle for every user and contains no secrets. The SPA
    // enforces auth client-side using the dev token paired via the QR flow.
    // Skipping the prefix here also keeps unknown sub-paths returning a clean
    // 404 from @fastify/static rather than a confusing 401.
    if (request.url.startsWith('/mobile/') || request.url === '/mobile') return;

    const routeConfig = request.routeOptions?.config as
      | { auth?: boolean | 'pod-token' }
      | undefined;

    // Skip auth entirely
    if (routeConfig?.auth === false) return;

    // Pod-token mode: accept HMAC pod token or regular user token — Bearer header only.
    // Containers use HMAC tokens issued by sessionTokenIssuer; human callers use Entra tokens.
    if (routeConfig?.auth === 'pod-token') {
      const routeSessionId = (request.params as Record<string, string>)?.podId;

      const authHeader = request.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

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
