import type { FastifyInstance } from 'fastify';
import type { ActionRegistry } from '../../actions/action-registry.js';

export function actionRoutes(app: FastifyInstance, registry: ActionRegistry): void {
  app.get('/actions/catalog', { config: { auth: false } }, async () => {
    return registry.getAllDefaults().map((a) => ({
      name: a.name,
      description: a.description,
      group: a.group,
    }));
  });
}
