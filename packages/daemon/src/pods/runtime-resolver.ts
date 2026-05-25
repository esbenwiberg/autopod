import type { Profile, RuntimeType } from '@autopod/shared';
import type { Logger } from 'pino';

export const CODEX_DEFAULT_MODEL = 'auto';

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

function usesOpenAiSurface(profile: Profile): boolean {
  if (profile.modelProvider === 'openai') return true;
  if (profile.modelProvider !== 'foundry') return false;

  const creds = profile.providerCredentials;
  return creds?.provider === 'foundry' && (creds.apiSurface ?? 'anthropic') === 'openai';
}

function usesChatGptAuth(profile: Profile): boolean {
  const creds = profile.providerCredentials;
  return creds?.provider === 'openai' && creds.authMode === 'chatgpt';
}

function isClaudeModel(model: string): boolean {
  return CLAUDE_MODEL_ALIASES.has(model) || model.startsWith('claude-');
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

export function resolvePodModel(
  profile: Profile,
  requestedModel: string | undefined,
  runtime: RuntimeType,
  logger?: Logger,
): string {
  const model =
    requestedModel ?? profile.defaultModel ?? (runtime === 'codex' ? CODEX_DEFAULT_MODEL : 'opus');

  if (
    runtime === 'codex' &&
    usesOpenAiSurface(profile) &&
    (isClaudeModel(model) || (usesChatGptAuth(profile) && model === 'gpt-5-codex'))
  ) {
    logger?.warn(
      { profile: profile.name, modelProvider: profile.modelProvider, requestedModel: model },
      'Overriding incompatible model to Codex default for OpenAI-compatible model provider',
    );
    return CODEX_DEFAULT_MODEL;
  }

  return model;
}
