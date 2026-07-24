import { PROVIDER_CATALOG } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';

export function modelProviderRoutes(app: FastifyInstance): void {
  app.get('/model-providers', async () => PROVIDER_CATALOG);
}
