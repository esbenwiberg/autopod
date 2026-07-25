export const PROVIDER_MANIFEST_VERSION = 1 as const;

export type ProviderManifestVersion = typeof PROVIDER_MANIFEST_VERSION;
export type ProviderImplementationKind = 'legacy' | 'generic-pi-api';
export type ProviderCredentialKind = 'api-key' | 'oauth' | 'managed-identity' | 'opaque';
export type ProviderLifecycleState = 'active' | 'deprecated' | 'experimental';
export type ProviderAuthorizationState = 'supported' | 'authorization-pending' | 'blocked';
export type ProviderModelLifecycleState = 'active' | 'deprecated';
export type ProviderCaveatKind =
  | 'privacy'
  | 'retention'
  | 'subscription'
  | 'spend'
  | 'metered-fallback';
export type ProviderCaveatSeverity = 'info' | 'warning' | 'blocking';

export interface ProviderCredentialOption {
  kind: ProviderCredentialKind;
  label: string;
  acquisition: string;
}

export interface ProviderCaveat {
  kind: ProviderCaveatKind;
  severity: ProviderCaveatSeverity;
  message: string;
}

export interface ProviderPolicy {
  lifecycle: ProviderLifecycleState;
  authorization: ProviderAuthorizationState;
  runnable: boolean;
  caveats: ProviderCaveat[];
}

export interface LegacyProviderImplementation {
  kind: 'legacy';
  /** Existing closed-code adapter. Its credential shape must not be reinterpreted. */
  adapterId: string;
}

export interface GenericPiProviderImplementation {
  kind: 'generic-pi-api';
  /** Provider ID understood by the pinned Pi distribution. */
  piProviderId: string;
}

export type ProviderImplementation = LegacyProviderImplementation | GenericPiProviderImplementation;

export interface CompiledProvider {
  id: string;
  displayName: string;
  description: string;
  icon?: string;
  implementation: ProviderImplementation;
  credentialOptions: ProviderCredentialOption[];
  modelIds: string[];
  requiredHosts: string[];
  policy: ProviderPolicy;
}

export interface CompiledProviderModel {
  /** Provider-qualified Pi model ID, for example `moonshotai/kimi-k2.5`. */
  id: string;
  providerId: string;
  displayName: string;
  lifecycle: ProviderModelLifecycleState;
}

export interface PiCatalogCompatibility {
  packageName: string;
  packageVersion: string;
  /**
   * The manifest was reviewed against this pin. Runtime drift checks are owned by
   * preflight; this compiled catalog never fetches a remote registry.
   */
  source: 'pinned-distribution';
}

export interface CompiledProviderManifest {
  manifestVersion: ProviderManifestVersion;
  piCompatibility: PiCatalogCompatibility;
  providers: CompiledProvider[];
  models: CompiledProviderModel[];
}

/** The daemon response is intentionally the non-secret compiled manifest. */
export type PublicProviderCatalog = CompiledProviderManifest;
