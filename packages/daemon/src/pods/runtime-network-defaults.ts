import type { CompiledProvider, NetworkPolicy, Profile, RuntimeType } from '@autopod/shared';
import { usesOpenAiSurface } from './runtime-resolver.js';

const CODEX_PROVIDER_REQUIRED_HOSTS = ['chatgpt.com', '*.chatgpt.com'];

export function addRuntimeNetworkDefaults(
  policy: NetworkPolicy | null,
  profile: Profile,
  runtime: RuntimeType,
  manifestProvider?: CompiledProvider | null,
): NetworkPolicy | null {
  if (!policy?.enabled) return policy;
  if ((policy.mode ?? 'restricted') !== 'restricted') return policy;

  const requiredHosts =
    manifestProvider?.implementation.kind === 'generic-pi-api'
      ? manifestProvider.requiredHosts
      : runtime === 'codex' || usesOpenAiSurface(profile)
        ? CODEX_PROVIDER_REQUIRED_HOSTS
        : [];
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
