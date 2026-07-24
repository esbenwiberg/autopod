import {
  type CompiledProvider,
  type CompiledProviderManifest,
  PROVIDER_MANIFEST_VERSION,
  type ProviderAuthorizationState,
  type ProviderCaveatKind,
  type ProviderCaveatSeverity,
  type ProviderCredentialKind,
  type ProviderLifecycleState,
  type ProviderModelLifecycleState,
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
const PROVIDER_LIFECYCLE_STATES = new Set<ProviderLifecycleState>([
  'active',
  'deprecated',
  'experimental',
]);
const AUTHORIZATION_STATES = new Set<ProviderAuthorizationState>([
  'supported',
  'authorization-pending',
  'blocked',
]);
const MODEL_LIFECYCLE_STATES = new Set<ProviderModelLifecycleState>(['active', 'deprecated']);
const CAVEAT_KINDS = new Set<ProviderCaveatKind>([
  'privacy',
  'retention',
  'subscription',
  'spend',
  'metered-fallback',
]);
const CAVEAT_SEVERITIES = new Set<ProviderCaveatSeverity>(['info', 'warning', 'blocking']);
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
    if (credential.label.trim().length === 0 || credential.acquisition.trim().length === 0) {
      fail(`provider '${provider.id}' has incomplete credential guidance`);
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

  if (!PROVIDER_LIFECYCLE_STATES.has(provider.policy.lifecycle)) {
    fail(`provider '${provider.id}' has unsupported lifecycle '${provider.policy.lifecycle}'`);
  }
  if (!AUTHORIZATION_STATES.has(provider.policy.authorization)) {
    fail(
      `provider '${provider.id}' has unsupported authorization '${provider.policy.authorization}'`,
    );
  }
  for (const caveat of provider.policy.caveats) {
    if (!CAVEAT_KINDS.has(caveat.kind)) {
      fail(`provider '${provider.id}' has unsupported caveat kind '${caveat.kind}'`);
    }
    if (!CAVEAT_SEVERITIES.has(caveat.severity)) {
      fail(`provider '${provider.id}' has unsupported caveat severity '${caveat.severity}'`);
    }
    if (caveat.message.trim().length === 0) {
      fail(`provider '${provider.id}' has an empty caveat message`);
    }
  }
  if (provider.policy.runnable !== (provider.policy.authorization === 'supported')) {
    fail(`provider '${provider.id}' runnable state must match supported unattended authorization`);
  }
  if (provider.implementation.kind === 'legacy') {
    if (!STABLE_ID.test(provider.implementation.adapterId)) {
      fail(`provider '${provider.id}' has invalid legacy adapter ID`);
    }
  } else if (provider.implementation.kind === 'generic-pi-api') {
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
  } else {
    fail(
      `provider '${provider.id}' has unsupported implementation kind '${String(
        (provider.implementation as { kind?: unknown }).kind,
      )}'`,
    );
  }
}

function assertValidProviderManifest(manifest: CompiledProviderManifest): void {
  if (manifest.manifestVersion !== PROVIDER_MANIFEST_VERSION) {
    fail(`unsupported version '${String(manifest.manifestVersion)}'`);
  }
  if (
    manifest.piCompatibility.source !== 'pinned-distribution' ||
    manifest.piCompatibility.packageName.trim().length === 0 ||
    manifest.piCompatibility.packageVersion.trim().length === 0
  ) {
    fail('invalid pinned Pi compatibility metadata');
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
    if (model.displayName.trim().length === 0) fail(`model '${model.id}' has no display name`);
    if (!MODEL_LIFECYCLE_STATES.has(model.lifecycle)) {
      fail(`model '${model.id}' has unsupported lifecycle '${model.lifecycle}'`);
    }
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
}

export function validateProviderManifest(
  manifest: CompiledProviderManifest,
): CompiledProviderManifest {
  const isolated = JSON.parse(JSON.stringify(manifest)) as CompiledProviderManifest;
  assertValidProviderManifest(isolated);
  return deepFreeze(isolated);
}

export function createProviderCatalog(manifest: CompiledProviderManifest): PublicProviderCatalog {
  return validateProviderManifest(manifest);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
