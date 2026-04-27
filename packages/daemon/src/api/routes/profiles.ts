import { AutopodError } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { ImageBuilder } from '../../images/index.js';
import { type ProfileStore, buildSourceMap } from '../../profiles/index.js';

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

  // GET /profiles/:name/editor — editor-oriented payload
  // Returns the raw partial (with nulls preserved), the fully resolved profile,
  // the resolved parent (null for base profiles), a per-field source map,
  // and the name of the profile in the extends chain that actually owns the
  // provider credentials (null when the chain has no auth yet). Gives the
  // desktop everything it needs to render Inherited/Overridden chips and the
  // "Authenticated via <owner>" UX without re-implementing the merge.
  app.get('/profiles/:name/editor', async (request) => {
    const { name } = request.params as { name: string };
    const raw = profileStore.getRaw(name);
    const resolved = profileStore.get(name);
    const parent = raw.extends ? profileStore.get(raw.extends) : null;
    const sourceMap = buildSourceMap(raw, parent);
    const credentialOwner = profileStore.resolveCredentialOwner(name);
    return { raw, resolved, parent, sourceMap, credentialOwner };
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
    const body = (request.body ?? {}) as {
      rebuild?: boolean;
      gitPat?: string;
      registryPat?: string;
    };
    const profile = profileStore.get(name);

    if (!imageBuilder) {
      throw new AutopodError(
        'Image warming is not configured (missing Docker/ACR config)',
        'NOT_CONFIGURED',
        501,
      );
    }

    // The image build runs `git clone` inside the Dockerfile and (for some
    // templates) authenticates against private package registries. Both PATs
    // are already stored on the profile — fall back to those when the caller
    // doesn't pass them in the body, so the CLI never has to handle secrets.
    const gitPat =
      body.gitPat ??
      (profile.prProvider === 'github' ? profile.githubPat : profile.adoPat) ??
      undefined;
    const registryPat = body.registryPat ?? profile.registryPat ?? undefined;

    try {
      const result = await imageBuilder.buildWarmImage(profile, {
        rebuild: body.rebuild,
        gitPat: gitPat ?? undefined,
        registryPat: registryPat ?? undefined,
      });
      return {
        tag: result.tag,
        digest: result.digest,
        sizeMb: Math.floor(result.size / 1_048_576),
        buildDuration: result.buildDuration,
      };
    } catch (err) {
      // Re-throw as an AutopodError carrying the underlying message so the
      // caller sees the actual failure (auth, docker, etc.) instead of the
      // generic INTERNAL_ERROR Fastify maps unknown throws to.
      const message = err instanceof Error ? err.message : String(err);
      throw new AutopodError(`Warm image build failed: ${message}`, 'WARM_BUILD_FAILED', 500);
    }
  });
}
