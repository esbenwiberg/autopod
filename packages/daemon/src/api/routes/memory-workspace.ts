import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { PodManager } from '../../pods/index.js';

export function memoryWorkspaceRoutes(app: FastifyInstance, podManager: PodManager): void {
  // POST /pods/memory-workspace — create a workspace pod pre-loaded with all approved memories
  app.post('/pods/memory-workspace', async (request, reply) => {
    const body = request.body as { profileName?: string };

    if (!body.profileName) {
      reply.status(400);
      return { error: 'profileName is required' };
    }

    try {
      const pod = podManager.createMemoryWorkspace(body.profileName, request.user.oid);
      reply.status(201);
      return pod;
    } catch (err) {
      if (err instanceof AutopodError) {
        reply.status(err.statusCode ?? 400);
        return { error: err.message };
      }
      throw err;
    }
  });
}
