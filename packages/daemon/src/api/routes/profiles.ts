import type { FastifyInstance } from 'fastify';
import { AutopodError } from '@autopod/shared';
import type { ProfileStore } from '../../profiles/index.js';

export function profileRoutes(app: FastifyInstance, profileStore: ProfileStore): void {
  // POST /profiles — create profile
  app.post('/profiles', async (request, reply) => {
    const profile = profileStore.create(request.body as Record<string, unknown>);
    reply.status(201);
    return profile;
  });

  // GET /profiles — list profiles
  app.get('/profiles', async () => {
    return profileStore.list();
  });

  // GET /profiles/:name — get profile
  app.get('/profiles/:name', async (request) => {
    const { name } = request.params as { name: string };
    return profileStore.get(name);
  });

  // PUT /profiles/:name — update profile
  app.put('/profiles/:name', async (request) => {
    const { name } = request.params as { name: string };
    return profileStore.update(name, request.body as Record<string, unknown>);
  });

  // DELETE /profiles/:name — delete profile
  app.delete('/profiles/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    profileStore.delete(name);
    reply.status(204);
  });

  // POST /profiles/:name/warm — warm profile (stub)
  app.post('/profiles/:name/warm', async (request, _reply) => {
    const { name } = request.params as { name: string };
    // Verify profile exists
    profileStore.get(name);
    throw new AutopodError('Warm images not yet implemented', 'NOT_IMPLEMENTED', 501);
  });
}
