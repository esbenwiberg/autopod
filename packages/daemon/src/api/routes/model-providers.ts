import { type PublicProviderCatalog, PROVIDER_CATALOG } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';

export function modelProviderRoutes(
  app: FastifyInstance,
  catalog: PublicProviderCatalog = PROVIDER_CATALOG,
): void {
  app.get('/model-providers', async () => catalog);
}
