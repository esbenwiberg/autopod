import { AuthError } from '@autopod/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthModule } from '../../interfaces/index.js';

export function authPlugin(app: FastifyInstance, authModule: AuthModule): void {
  app.decorateRequest('user', null as any);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    // Skip auth if route config says so
    const routeConfig = request.routeOptions?.config as { auth?: boolean } | undefined;
    if (routeConfig?.auth === false) return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    request.user = await authModule.validateToken(token);
  });
}
