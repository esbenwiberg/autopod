import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { ImageBuilder } from '../../images/index.js';
import type { ProfileStore } from '../../profiles/index.js';

export function profileRoutes(
  app: FastifyInstance,
  profileStore: ProfileStore,
  refreshNetworkPolicy: (profileName: string) => Promise<void>,
  imageBuilder?: ImageBuilder,
): void {
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

  // PUT/PATCH /profiles/:name — update profile
  const updateHandler = async (request: import('fastify').FastifyRequest) => {
    const { name } = request.params as { name: string };
    const updated = profileStore.update(name, request.body as Record<string, unknown>);
    // Fire-and-forget: re-apply network policy to running containers using this profile
    refreshNetworkPolicy(name).catch(() => {
      // Errors are logged inside refreshNetworkPolicy — don't surface to caller
    });
    return updated;
  };
  app.put('/profiles/:name', updateHandler);
  app.patch('/profiles/:name', updateHandler);

  // DELETE /profiles/:name — delete profile
  app.delete('/profiles/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    profileStore.delete(name);
    reply.status(204);
  });

  // POST /profiles/:name/warm — build warm Docker image
  app.post('/profiles/:name/warm', async (request, _reply) => {
    const { name } = request.params as { name: string };
    const { rebuild, gitPat } = (request.body ?? {}) as { rebuild?: boolean; gitPat?: string };
    const profile = profileStore.get(name);

    if (!imageBuilder) {
      throw new AutopodError(
        'Image warming is not configured (missing Docker/ACR config)',
        'NOT_CONFIGURED',
        501,
      );
    }

    const result = await imageBuilder.buildWarmImage(profile, { rebuild, gitPat });
    return {
      tag: result.tag,
      digest: result.digest,
      sizeMb: Math.floor(result.size / 1_048_576),
      buildDuration: result.buildDuration,
    };
  });
}
