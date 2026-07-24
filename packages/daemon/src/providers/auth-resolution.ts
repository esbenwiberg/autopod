import type { ModelProvider, Profile, ProviderAccount, ProviderCredentials } from '@autopod/shared';
import { AutopodError, PROVIDER_CATALOG } from '@autopod/shared';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';

export type CredentialOwner =
  | { type: 'provider-account'; id: string }
  | { type: 'profile'; name: string };

export interface ProviderAuthResolution {
  provider: ModelProvider | null;
  credentials: ProviderCredentials | null;
  owner: CredentialOwner | null;
  account: ProviderAccount | null;
}

export function credentialOwnerKey(owner: CredentialOwner): string {
  return `${owner.type}:${owner.type === 'provider-account' ? owner.id : owner.name}`;
}

export function resolveProviderAuth(
  profile: Profile,
  options: {
    profileStore?: ProfileStore;
    providerAccountStore?: ProviderAccountStore;
  } = {},
): ProviderAuthResolution {
  const provider = profile.modelProvider;
  if (!provider) {
    return { provider: null, credentials: null, owner: null, account: null };
  }

  const providerAccountId =
    profile.providerAccountId ??
    options.profileStore?.resolveProviderAccountId?.(profile.name) ??
    null;
  if (providerAccountId) {
    if (!options.providerAccountStore) {
      throw new AutopodError(
        `Profile "${profile.name}" links provider account "${providerAccountId}" but provider account storage is not configured`,
        'PROVIDER_ACCOUNT_STORE_MISSING',
        500,
      );
    }

    const account = options.providerAccountStore.get(providerAccountId);
    const catalogProvider = PROVIDER_CATALOG.providers.find(
      (candidate) => candidate.id === account.provider,
    );
    const matchesLegacyProvider = account.provider === provider;
    const matchesGenericPiProvider =
      provider === 'pi' && catalogProvider?.implementation.kind === 'generic-pi-api';
    if (!matchesLegacyProvider && !matchesGenericPiProvider) {
      throw new AutopodError(
        `Profile "${profile.name}" uses modelProvider=${provider} but provider account "${account.name}" is for ${account.provider}`,
        'PROVIDER_ACCOUNT_PROVIDER_MISMATCH',
        400,
      );
    }

    return {
      provider,
      credentials: account.credentials,
      owner: { type: 'provider-account', id: account.id },
      account,
    };
  }

  const credentialOwner = options.profileStore?.resolveCredentialOwner(profile.name) ?? null;
  if (credentialOwner) {
    const ownerProfile = options.profileStore?.getRaw(credentialOwner);
    return {
      provider,
      credentials: ownerProfile?.providerCredentials ?? profile.providerCredentials,
      owner: { type: 'profile', name: credentialOwner },
      account: null,
    };
  }

  return {
    provider,
    credentials: profile.providerCredentials,
    owner: profile.providerCredentials ? { type: 'profile', name: profile.name } : null,
    account: null,
  };
}
