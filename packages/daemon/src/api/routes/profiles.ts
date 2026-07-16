import { AutopodError } from '@autopod/shared';
import type { ProfileEditorPayload, ProviderAuthSource } from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import type { DaemonGitHubAuth } from '../../github/daemon-github-auth.js';
import type { ImageBuilder } from '../../images/index.js';
import { type ProfileStore, buildSourceMap } from '../../profiles/index.js';
import type { ProviderAccountStore } from '../../provider-accounts/index.js';
import { redactProfileSecrets } from '../profile-redaction.js';
import { redactProviderAccountSecrets } from '../provider-account-redaction.js';

function hasEnvFallback(provider: ProviderAuthSource['provider']): boolean {
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  if (provider === 'openrouter') return Boolean(process.env.OPENROUTER_API_KEY);
  return false;
}

export function profileRoutes(
  app: FastifyInstance,
  profileStore: ProfileStore,
  refreshNetworkPolicy: (profileName: string) => Promise<void>,
  imageBuilder?: ImageBuilder,
  providerAccountStore?: ProviderAccountStore,
  githubAuth?: DaemonGitHubAuth,
): void {
  function validateProviderAccountMismatch(name: string, changes: Record<string, unknown>): void {
    if (!providerAccountStore) return;
    const existing = profileStore.get(name);
    const nextAccountId =
      changes.providerAccountId === undefined
        ? existing.providerAccountId
        : (changes.providerAccountId as string | null);
    if (!nextAccountId) return;

    const account = providerAccountStore.get(nextAccountId);
    const nextProvider =
      typeof changes.modelProvider === 'string' ? changes.modelProvider : existing.modelProvider;
    if (nextProvider !== account.provider) {
      throw new AutopodError(
        `Profile "${name}" uses modelProvider=${nextProvider ?? 'none'} but provider account "${account.name}" is for ${account.provider}`,
        'PROVIDER_ACCOUNT_PROVIDER_MISMATCH',
        400,
      );
    }
  }

  function resolveAuthSource(
    name: string,
    sourceMap: Record<string, 'own' | 'inherited' | 'merged'>,
  ): ProviderAuthSource {
    const resolved = profileStore.get(name);
    if (resolved.providerAccountId && providerAccountStore) {
      const account = providerAccountStore.get(resolved.providerAccountId);
      return {
        type: 'provider-account',
        provider: account.provider,
        account: redactProviderAccountSecrets(account),
        inherited: sourceMap.providerAccountId === 'inherited',
      };
    }

    const credentialOwner = profileStore.resolveCredentialOwner(name);
    if (credentialOwner && resolved.modelProvider) {
      return {
        type: 'legacy-profile',
        provider: resolved.modelProvider,
        profileName: credentialOwner,
      };
    }

    if (hasEnvFallback(resolved.modelProvider)) {
      return { type: 'env-fallback', provider: resolved.modelProvider };
    }

    return { type: 'none', provider: resolved.modelProvider };
  }

  // POST /profiles — create profile
  app.post('/profiles', async (request, reply) => {
    const profile = profileStore.create(request.body as Record<string, unknown>);
    reply.status(201);
    return redactProfileSecrets(profile);
  });

  // GET /profiles — list profiles
  app.get('/profiles', async () => {
    return profileStore.list().map(redactProfileSecrets);
  });

  app.get(
    '/profiles/github-auth/status',
    async () =>
      githubAuth?.getStatus() ?? {
        available: false,
        reason: 'Daemon GitHub authentication is not configured',
        setup: 'Run gh auth login as the daemon service account',
      },
  );

  // GET /profiles/:name — get profile
  app.get('/profiles/:name', async (request) => {
    const { name } = request.params as { name: string };
    return redactProfileSecrets(profileStore.get(name));
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
    const authSource = resolveAuthSource(name, sourceMap);
    return {
      raw: redactProfileSecrets(raw),
      resolved: redactProfileSecrets(resolved),
      parent: parent ? redactProfileSecrets(parent) : null,
      sourceMap,
      authSource,
      providerAccountId: resolved.providerAccountId,
      credentialOwner,
    } satisfies ProfileEditorPayload;
  });

  // PUT/PATCH /profiles/:name — update profile
  const updateHandler = async (request: import('fastify').FastifyRequest) => {
    const { name } = request.params as { name: string };
    const changes = request.body as Record<string, unknown>;
    validateProviderAccountMismatch(name, changes);
    const updated = profileStore.update(name, changes);
    // Fire-and-forget: re-apply network policy to running containers using this profile
    refreshNetworkPolicy(name).catch(() => {
      // Errors are logged inside refreshNetworkPolicy — don't surface to caller
    });
    return redactProfileSecrets(updated);
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
      profile.prProvider === 'github'
        ? (await githubAuth?.resolveCredential())?.token
        : (body.gitPat ?? profile.adoPat ?? undefined);
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
