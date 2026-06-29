import {
  AutopodError,
  importProviderAccountFromProfileSchema,
  providerAccountIdSchema,
  providerAccountProviderSchema,
} from '@autopod/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProfileStore } from '../../profiles/index.js';
import type { ProviderAccountStore } from '../../provider-accounts/index.js';
import { redactProfileSecrets } from '../profile-redaction.js';
import { redactProviderAccountSecrets } from '../provider-account-redaction.js';

const profileProviderAccountPatchSchema = z.object({
  accountId: providerAccountIdSchema.nullable(),
  clearLegacyCredentials: z.boolean().optional().default(false),
});

const linkProviderProfileSchema = z.object({
  profileName: z.string().min(1),
  clearLegacyCredentials: z.boolean().optional().default(false),
});

function assertAccountMatchesProfile(
  account: ReturnType<ProviderAccountStore['get']>,
  profile: ReturnType<ProfileStore['get']>,
): void {
  if (profile.modelProvider !== account.provider) {
    throw new AutopodError(
      `Profile "${profile.name}" uses modelProvider=${profile.modelProvider ?? 'none'} but provider account "${account.name}" is for ${account.provider}`,
      'PROVIDER_ACCOUNT_PROVIDER_MISMATCH',
      400,
    );
  }
}

export function providerAccountRoutes(
  app: FastifyInstance,
  providerAccountStore: ProviderAccountStore,
  profileStore: ProfileStore,
): void {
  app.get('/provider-accounts', async (request) => {
    const query = request.query as { provider?: string };
    const provider = query.provider
      ? providerAccountProviderSchema.parse(query.provider)
      : undefined;
    const accounts = providerAccountStore.list(provider ? { provider } : undefined);
    return accounts.map(redactProviderAccountSecrets);
  });

  app.post('/provider-accounts', async (request, reply) => {
    const account = providerAccountStore.create(request.body as Record<string, unknown>);
    reply.status(201);
    return redactProviderAccountSecrets(account);
  });

  app.get('/provider-accounts/:id', async (request) => {
    const { id } = request.params as { id: string };
    return redactProviderAccountSecrets(providerAccountStore.get(id));
  });

  app.patch('/provider-accounts/:id', async (request) => {
    const { id } = request.params as { id: string };
    const account = providerAccountStore.update(id, request.body as Record<string, unknown>);
    return redactProviderAccountSecrets(account);
  });

  app.delete('/provider-accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    providerAccountStore.delete(id);
    reply.status(204);
  });

  app.post('/provider-accounts/:id/link-profile', async (request) => {
    const { id } = request.params as { id: string };
    const body = linkProviderProfileSchema.parse(request.body ?? {});
    const account = providerAccountStore.get(id);
    const profile = profileStore.get(body.profileName);
    assertAccountMatchesProfile(account, profile);
    const updated = profileStore.update(body.profileName, {
      providerAccountId: id,
      ...(body.clearLegacyCredentials ? { providerCredentials: null } : {}),
    });
    return {
      account: redactProviderAccountSecrets(account),
      profile: redactProfileSecrets(updated),
    };
  });

  app.post('/profiles/:name/provider-account', async (request) => {
    const { name } = request.params as { name: string };
    const body = profileProviderAccountPatchSchema.parse(request.body ?? {});
    if (body.accountId === null) {
      const updated = profileStore.update(name, {
        providerAccountId: null,
        ...(body.clearLegacyCredentials ? { providerCredentials: null } : {}),
      });
      return redactProfileSecrets(updated);
    }

    const account = providerAccountStore.get(body.accountId);
    const profile = profileStore.get(name);
    assertAccountMatchesProfile(account, profile);
    const updated = profileStore.update(name, {
      providerAccountId: body.accountId,
      ...(body.clearLegacyCredentials ? { providerCredentials: null } : {}),
    });
    return redactProfileSecrets(updated);
  });

  app.delete('/profiles/:name/provider-account', async (request, reply) => {
    const { name } = request.params as { name: string };
    profileStore.update(name, { providerAccountId: null });
    reply.status(204);
  });

  app.post('/provider-accounts/import-from-profile', async (request) => {
    const body = importProviderAccountFromProfileSchema.parse(request.body ?? {});
    const ownerName = profileStore.resolveCredentialOwner(body.profileName) ?? body.profileName;
    const ownerProfile = profileStore.getRaw(ownerName);
    const credentials = ownerProfile.providerCredentials;
    if (!credentials) {
      throw new AutopodError(
        `Profile "${body.profileName}" has no legacy provider credentials to import`,
        'PROVIDER_CREDENTIALS_NOT_FOUND',
        404,
      );
    }

    const account = body.accountId
      ? providerAccountStore.exists(body.accountId)
        ? providerAccountStore.updateCredentials(body.accountId, credentials)
        : providerAccountStore.create({
            id: body.accountId,
            name: body.accountName ?? `${credentials.provider} ${ownerName}`,
            provider: credentials.provider,
            credentials,
          })
      : providerAccountStore.create({
          name: body.accountName ?? `${credentials.provider} ${ownerName}`,
          provider: credentials.provider,
          credentials,
        });

    const requestedProfileNames =
      body.linkProfileNames.length > 0 ? body.linkProfileNames : [body.profileName];
    const linkedProfiles = requestedProfileNames.map((profileName) => {
      const profile = profileStore.get(profileName);
      assertAccountMatchesProfile(account, profile);
      return profileStore.update(profileName, { providerAccountId: account.id });
    });

    if (body.clearLegacyCredentials) {
      profileStore.update(ownerName, { providerCredentials: null });
    }

    return {
      account: redactProviderAccountSecrets(providerAccountStore.get(account.id)),
      linkedProfiles: linkedProfiles.map(redactProfileSecrets),
      legacyCredentialsCleared: body.clearLegacyCredentials,
    };
  });
}
