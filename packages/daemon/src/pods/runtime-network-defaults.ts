import type {
  CompiledProvider,
  NetworkPolicy,
  ProviderAccount,
  RuntimeType,
} from '@autopod/shared';
import type { PodExecutionSettings } from '../interfaces/pod-execution-settings.js';
import { foundryEndpointHost } from '../providers/foundry-endpoint.js';
import { usesOpenAiSurface } from './runtime-resolver.js';

const CODEX_PROVIDER_REQUIRED_HOSTS = ['chatgpt.com', '*.chatgpt.com', 'auth.openai.com'];

export function addRuntimeNetworkDefaults(
  policy: NetworkPolicy | null,
  profile: PodExecutionSettings,
  runtime: RuntimeType,
  manifestProvider?: CompiledProvider | null,
  providerAccount?: ProviderAccount | null,
): NetworkPolicy | null {
  if (!policy?.enabled) return policy;
  if ((policy.mode ?? 'restricted') !== 'restricted') return policy;

  const requiredHosts = [
    ...(manifestProvider?.implementation.kind === 'generic-pi-api'
      ? manifestProvider.requiredHosts
      : runtime === 'codex' || usesOpenAiSurface(profile)
        ? CODEX_PROVIDER_REQUIRED_HOSTS
        : []),
    ...foundryRequiredHosts(profile, providerAccount),
  ];
  if (requiredHosts.length === 0) return policy;

  const allowedHosts = new Set(policy.allowedHosts);
  let changed = false;
  for (const host of requiredHosts) {
    if (!allowedHosts.has(host)) {
      allowedHosts.add(host);
      changed = true;
    }
  }

  return changed ? { ...policy, allowedHosts: [...allowedHosts] } : policy;
}

/**
 * A Foundry pod must reach its own resource endpoint. Only canonical Azure
 * Foundry hosts are auto-allowed; a custom gateway endpoint has to be added to
 * the profile's network policy explicitly.
 */
function foundryRequiredHosts(
  profile: PodExecutionSettings,
  providerAccount: ProviderAccount | null | undefined,
): string[] {
  const credentials = providerAccount ? providerAccount.credentials : profile.providerCredentials;
  if (credentials?.provider !== 'foundry') return [];
  const host = foundryEndpointHost(credentials.endpoint);
  return host ? [host] : [];
}
