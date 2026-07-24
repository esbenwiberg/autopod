import {
  type CompiledProvider,
  type CompiledProviderManifest,
  PROVIDER_MANIFEST_VERSION,
  type ProviderCredentialKind,
  type PublicProviderCatalog,
} from '../types/provider-catalog.js';

const STABLE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_HOSTNAME =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const SUPPORTED_CREDENTIAL_KINDS = new Set<ProviderCredentialKind>([
  'api-key',
  'oauth',
  'managed-identity',
  'opaque',
]);
const METADATA_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.googleapis.com',
  'metadata.azure.com',
  'instance-data',
]);

function fail(message: string): never {
  throw new Error(`Invalid provider manifest: ${message}`);
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail(`duplicate ${label} '${value}'`);
    seen.add(value);
  }
}

function assertSafePublicHostname(host: string, providerId: string): void {
  const normalized = host.toLowerCase();
  if (
    !SAFE_HOSTNAME.test(host) ||
    /^\d+(?:\.\d+){3}$/.test(normalized) ||
    normalized === 'localhost' ||
    METADATA_HOSTNAMES.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  ) {
    fail(`provider '${providerId}' has unsafe required host '${host}'`);
  }
}

function assertProvider(provider: CompiledProvider, modelOwners: Map<string, string>): void {
  if (!STABLE_ID.test(provider.id)) fail(`provider ID '${provider.id}' is not stable`);
  if (provider.displayName.trim().length === 0)
    fail(`provider '${provider.id}' has no display name`);
  if (provider.description.trim().length === 0)
    fail(`provider '${provider.id}' has no description`);
  if (provider.credentialOptions.length === 0) {
    fail(`provider '${provider.id}' has no credential options`);
  }
  for (const credential of provider.credentialOptions) {
    if (!SUPPORTED_CREDENTIAL_KINDS.has(credential.kind)) {
      fail(`provider '${provider.id}' uses unsupported credential kind '${credential.kind}'`);
    }
  }
  assertUnique(
    provider.credentialOptions.map(({ kind }) => kind),
    `credential kind on provider '${provider.id}'`,
  );
  assertUnique(provider.modelIds, `model reference on provider '${provider.id}'`);
  for (const modelId of provider.modelIds) {
    const owner = modelOwners.get(modelId);
    if (!owner) {
      fail(`provider '${provider.id}' references unknown model '${modelId}'`);
    }
    if (owner !== provider.id) {
      fail(`provider '${provider.id}' references model '${modelId}' owned by '${owner}'`);
    }
  }
  assertUnique(provider.requiredHosts, `required host on provider '${provider.id}'`);
  for (const host of provider.requiredHosts) assertSafePublicHostname(host, provider.id);

  if (provider.policy.runnable !== (provider.policy.authorization === 'supported')) {
    fail(`provider '${provider.id}' runnable state must match supported unattended authorization`);
  }
  if (provider.implementation.kind === 'generic-pi-api') {
    if (!STABLE_ID.test(provider.implementation.piProviderId)) {
      fail(`provider '${provider.id}' has invalid Pi provider ID`);
    }
    if (!provider.credentialOptions.some(({ kind }) => kind === 'api-key')) {
      fail(`generic Pi provider '${provider.id}' must support api-key credentials`);
    }
    for (const modelId of provider.modelIds) {
      if (!modelId.startsWith(`${provider.implementation.piProviderId}/`)) {
        fail(`model '${modelId}' is inconsistent with provider '${provider.id}' Pi mapping`);
      }
    }
  }
}

export function validateProviderManifest(
  manifest: CompiledProviderManifest,
): CompiledProviderManifest {
  if (manifest.manifestVersion !== PROVIDER_MANIFEST_VERSION) {
    fail(`unsupported version '${String(manifest.manifestVersion)}'`);
  }
  assertUnique(
    manifest.providers.map(({ id }) => id),
    'provider ID',
  );
  assertUnique(
    manifest.models.map(({ id }) => id),
    'model ID',
  );

  const providers = new Set(manifest.providers.map(({ id }) => id));
  for (const model of manifest.models) {
    if (!STABLE_ID.test(model.providerId)) fail(`model '${model.id}' has invalid provider ID`);
    if (!providers.has(model.providerId)) {
      fail(`model '${model.id}' references unknown provider '${model.providerId}'`);
    }
  }
  const modelOwners = new Map(manifest.models.map(({ id, providerId }) => [id, providerId]));
  for (const provider of manifest.providers) assertProvider(provider, modelOwners);
  const providerById = new Map(manifest.providers.map((provider) => [provider.id, provider]));
  for (const model of manifest.models) {
    if (!providerById.get(model.providerId)?.modelIds.includes(model.id)) {
      fail(`model '${model.id}' is not referenced by its provider '${model.providerId}'`);
    }
  }
  return manifest;
}

export function createProviderCatalog(manifest: CompiledProviderManifest): PublicProviderCatalog {
  return validateProviderManifest(manifest);
}
