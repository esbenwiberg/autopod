import {
  type AgentRoute,
  PROVIDER_CATALOG,
  type PublicProviderCatalog,
  type ResolvedAgentAccount,
} from '@autopod/shared';
import type { ProviderAccountStore } from '../provider-accounts/provider-account-store.js';
import { resolveProviderAccountAuth } from '../providers/auth-resolution.js';
import { configurationError } from './configuration-store.js';

/** Read-only account binding: no refresh, ambient key fallback, or account-level failover. */
export function resolveLaunchAgentRoute(
  route: AgentRoute,
  store: ProviderAccountStore,
  catalog: PublicProviderCatalog = PROVIDER_CATALOG,
): ResolvedAgentAccount {
  const auth = resolveProviderAccountAuth(route.providerAccountId, {
    providerAccountStore: store,
    providerCatalog: catalog,
  });
  const account = auth.account;
  const credentials = auth.credentials;
  if (!account || !auth.provider || !credentials)
    configurationError(
      'The selected provider account is not authenticated',
      'PROVIDER_CREDENTIALS_MISSING',
      409,
    );
  if (
    (credentials.provider === 'anthropic' && !credentials.apiKey?.trim()) ||
    (credentials.provider === 'openai' && !credentials.authJson?.trim()) ||
    (credentials.provider === 'api-key' && !credentials.apiKey.trim())
  )
    configurationError(
      'Authenticate this provider account explicitly; daemon environment keys are not launch account credentials',
      'PROVIDER_CREDENTIALS_MISSING',
      409,
    );
  if (
    auth.provider === 'copilot' ||
    (credentials.provider === 'pi' && credentials.providerId === 'github-copilot')
  )
    configurationError(
      'This GitHub-backed agent credential has no verified isolation from source publication. Select an isolated AI account.',
      'PROVIDER_SOURCE_AUTHORITY_UNVERIFIED',
    );
  const requiredRuntime =
    auth.provider === 'pi'
      ? 'pi'
      : auth.provider === 'openai' ||
          auth.provider === 'openrouter' ||
          (credentials.provider === 'foundry' && credentials.apiSurface === 'openai')
        ? 'codex'
        : 'claude';
  if (route.runtime !== requiredRuntime)
    configurationError(
      `This account requires the ${requiredRuntime} runtime`,
      'PROVIDER_RUNTIME_MISMATCH',
    );
  const manifest = catalog.providers.find((provider) => provider.id === account.provider);
  if (
    !manifest ||
    manifest.policy.authorization !== 'supported' ||
    !manifest.policy.runnable ||
    manifest.policy.lifecycle === 'deprecated'
  )
    configurationError('The selected provider is not approved to run', 'PROVIDER_NOT_RUNNABLE');
  if (manifest.implementation.kind === 'generic-pi-api') {
    const model = catalog.models.find(
      (model) => model.id === route.model && model.providerId === account.provider,
    );
    if (!model || model.lifecycle === 'deprecated' || !manifest.modelIds.includes(model.id))
      configurationError(
        'The selected model is not available for this account',
        'PROVIDER_MODEL_UNKNOWN',
      );
  }
  return {
    accountId: account.id,
    providerId: account.provider,
    adapter: auth.provider,
    createdAt: account.createdAt,
  };
}

export function assertLaunchAgentAccount(
  route: AgentRoute,
  expected: ResolvedAgentAccount | undefined,
  store: ProviderAccountStore,
  catalog?: PublicProviderCatalog,
): ResolvedAgentAccount {
  const actual = resolveLaunchAgentRoute(route, store, catalog);
  if (
    !expected ||
    actual.accountId !== expected.accountId ||
    actual.providerId !== expected.providerId ||
    actual.adapter !== expected.adapter ||
    actual.createdAt !== expected.createdAt
  )
    configurationError(
      'The selected provider account identity changed after launch',
      'PROVIDER_BINDING_MISMATCH',
      409,
    );
  return actual;
}
