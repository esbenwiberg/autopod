import type { Profile, RuntimeType } from '@autopod/shared';
import type { Logger } from 'pino';

function usesOpenAiSurface(profile: Profile): boolean {
  if (profile.modelProvider === 'openai') return true;
  if (profile.modelProvider !== 'foundry') return false;

  const creds = profile.providerCredentials;
  return creds?.provider === 'foundry' && (creds.apiSurface ?? 'anthropic') === 'openai';
}

export function resolvePodRuntime(
  profile: Profile,
  requestedRuntime: RuntimeType | undefined,
  logger?: Logger,
): RuntimeType {
  const runtime = requestedRuntime ?? profile.defaultRuntime ?? 'claude';

  if (usesOpenAiSurface(profile) && runtime !== 'codex') {
    logger?.warn(
      { profile: profile.name, modelProvider: profile.modelProvider, requestedRuntime: runtime },
      'Overriding runtime to codex for OpenAI-compatible model provider',
    );
    return 'codex';
  }

  return runtime;
}
