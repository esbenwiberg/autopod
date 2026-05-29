import type { NetworkPolicy, Profile, RuntimeType } from '@autopod/shared';
import { usesOpenAiSurface } from './runtime-resolver.js';

const CODEX_PROVIDER_REQUIRED_HOSTS = ['chatgpt.com', '*.chatgpt.com'];

export function addRuntimeNetworkDefaults(
  policy: NetworkPolicy | null,
  profile: Profile,
  runtime: RuntimeType,
): NetworkPolicy | null {
  if (!policy?.enabled) return policy;
  if (runtime !== 'codex' && !usesOpenAiSurface(profile)) return policy;

  const allowedHosts = new Set(policy.allowedHosts);
  let changed = false;
  for (const host of CODEX_PROVIDER_REQUIRED_HOSTS) {
    if (!allowedHosts.has(host)) {
      allowedHosts.add(host);
      changed = true;
    }
  }

  return changed ? { ...policy, allowedHosts: [...allowedHosts] } : policy;
}
