import type {
  CompiledProvider,
  CompiledProviderManifest,
  Profile,
  ProviderAccount,
  RuntimeType,
} from '@autopod/shared';
import { AutopodError, PROVIDER_CATALOG } from '@autopod/shared';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { resolveProviderAuth } from '../providers/auth-resolution.js';
import { resolvePodModel, resolvePodRuntime } from './runtime-resolver.js';

export interface ProviderPreflightTuple {
  runtime: RuntimeType;
  model: string;
  account: ProviderAccount | null;
  manifestProvider: CompiledProvider | null;
}

export interface ProviderPreflightOptions {
  profileStore?: ProfileStore;
  providerAccountStore?: ProviderAccountStore;
  manifest?: CompiledProviderManifest;
}

function reject(message: string, code: string): never {
  throw new AutopodError(message, code, 400);
}

/**
 * Resolves the effective runtime, provider account, provider-qualified model, and
 * provider policy as one fail-closed tuple. Legacy provider/runtime combinations
 * continue through their existing resolver and credential adapter unchanged.
 */
export function resolveProviderPreflight(
  profile: Profile,
  requestedRuntime: RuntimeType | undefined,
  requestedModel: string | undefined,
  options: ProviderPreflightOptions = {},
): ProviderPreflightTuple {
  const runtime = resolvePodRuntime(profile, requestedRuntime);
  const model = resolvePodModel(profile, requestedModel, runtime);
  const providerAccountId =
    profile.providerAccountId ??
    options.profileStore?.resolveProviderAccountId?.(profile.name) ??
    null;
  let account: ProviderAccount | null = null;
  if (providerAccountId) {
    if (!options.providerAccountStore) {
      throw new AutopodError(
        'Selected profile requires provider account storage',
        'PROVIDER_ACCOUNT_STORE_MISSING',
        500,
      );
    }
    try {
      account = options.providerAccountStore.get(providerAccountId);
    } catch (error) {
      if (error instanceof AutopodError && error.code === 'PROVIDER_ACCOUNT_NOT_FOUND') {
        reject('Selected provider account was not found', 'PROVIDER_ACCOUNT_NOT_FOUND');
      }
      throw error;
    }
  }

  if (profile.modelProvider !== 'pi') {
    const auth = resolveProviderAuth(profile, options);
    return { runtime, model, account: auth.account, manifestProvider: null };
  }

  const manifest = options.manifest ?? PROVIDER_CATALOG;
  const selectedModel = manifest.models.find(({ id }) => id === model);
  const modelProvider = selectedModel
    ? manifest.providers.find(({ id }) => id === selectedModel.providerId)
    : undefined;
  const accountProvider = account
    ? manifest.providers.find(({ id }) => id === account?.provider)
    : undefined;
  const provider = accountProvider ?? modelProvider;
  const selectsGenericProvider =
    provider?.implementation.kind === 'generic-pi-api' ||
    (account !== null && accountProvider === undefined) ||
    (model.includes('/') && selectedModel === undefined);
  if (!selectsGenericProvider) {
    if (account) resolveProviderAuth(profile, options);
    return { runtime, model, account, manifestProvider: null };
  }
  if (!provider) {
    reject('Selected provider is not in the reviewed provider catalog', 'PROVIDER_UNKNOWN');
  }
  if (provider.implementation.kind !== 'generic-pi-api') {
    const auth = resolveProviderAuth(profile, options);
    return { runtime, model, account: auth.account, manifestProvider: null };
  }

  if (
    modelProvider?.implementation.kind === 'generic-pi-api' &&
    accountProvider?.implementation.kind === 'generic-pi-api' &&
    modelProvider.id !== accountProvider.id
  ) {
    reject(
      'Selected provider account does not match the selected model',
      'PROVIDER_ACCOUNT_PROVIDER_MISMATCH',
    );
  }
  if (
    manifest.piCompatibility.packageName !== PROVIDER_CATALOG.piCompatibility.packageName ||
    manifest.piCompatibility.packageVersion !== PROVIDER_CATALOG.piCompatibility.packageVersion
  ) {
    reject(
      'Selected provider is incompatible with the pinned Pi catalog',
      'PROVIDER_PI_CATALOG_INCOMPATIBLE',
    );
  }
  if (!account) {
    reject('Selected provider requires a linked provider account', 'PROVIDER_ACCOUNT_REQUIRED');
  }
  if (account.provider !== provider.id) {
    reject(
      'Selected provider account does not match the selected model',
      'PROVIDER_ACCOUNT_PROVIDER_MISMATCH',
    );
  }
  if (runtime !== 'pi') {
    reject('Selected provider requires the managed Pi runtime', 'PROVIDER_RUNTIME_MISMATCH');
  }
  if (provider.policy.authorization === 'blocked') {
    reject('Selected provider is blocked by policy', 'PROVIDER_BLOCKED');
  }
  if (provider.policy.authorization === 'authorization-pending') {
    reject(
      'Selected provider is pending authorization for unattended use',
      'PROVIDER_AUTHORIZATION_PENDING',
    );
  }
  if (!provider.policy.runnable) {
    reject('Selected provider is not approved to run', 'PROVIDER_NOT_RUNNABLE');
  }
  if (provider.policy.lifecycle === 'deprecated') {
    reject('Selected provider is deprecated', 'PROVIDER_DEPRECATED');
  }

  const manifestModel = manifest.models.find(({ id }) => id === model);
  if (!manifestModel || !provider.modelIds.includes(model)) {
    reject('Selected model is not reviewed for this provider', 'PROVIDER_MODEL_UNKNOWN');
  }
  if (
    manifestModel.providerId !== provider.id ||
    !model.startsWith(`${provider.implementation.piProviderId}/`)
  ) {
    reject(
      'Selected provider and model are incompatible with the pinned Pi catalog',
      'PROVIDER_MODEL_INCOMPATIBLE',
    );
  }
  if (manifestModel.lifecycle === 'deprecated') {
    reject('Selected provider model is deprecated', 'PROVIDER_MODEL_DEPRECATED');
  }

  const credentials = account.credentials;
  if (!credentials) {
    reject('Selected provider account has no credentials', 'PROVIDER_CREDENTIALS_MISSING');
  }
  if (
    credentials.provider !== 'api-key' ||
    credentials.providerId !== provider.id ||
    credentials.providerId !== account.provider
  ) {
    reject(
      'Selected provider account credentials do not match the provider',
      'PROVIDER_CREDENTIAL_MISMATCH',
    );
  }

  return { runtime, model, account, manifestProvider: provider };
}
