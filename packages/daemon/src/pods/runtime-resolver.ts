import {
  AutopodError,
  type ModelProvider,
  type Profile,
  type RuntimeType,
  CLAUDE_DEFAULT_MODEL as SHARED_CLAUDE_DEFAULT_MODEL,
  CLAUDE_REVIEWER_MODEL as SHARED_CLAUDE_REVIEWER_MODEL,
} from '@autopod/shared';
import type { Logger } from 'pino';

export const CODEX_DEFAULT_MODEL = 'auto';
export const CLAUDE_DEFAULT_MODEL = SHARED_CLAUDE_DEFAULT_MODEL;
export const CLAUDE_REVIEWER_MODEL = SHARED_CLAUDE_REVIEWER_MODEL;

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

export function usesOpenAiSurface(profile: Profile): boolean {
  if (profile.modelProvider === 'openai') return true;
  if (profile.modelProvider === 'openrouter') return true;
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

  if (runtime === 'pi') {
    throw new AutopodError(
      'Pi runtime is not available yet: no Pi runtime adapter is registered in this daemon build',
      'UNSUPPORTED_RUNTIME',
      400,
    );
  }

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
    requestedModel ??
    profile.defaultModel ??
    (runtime === 'codex' ? CODEX_DEFAULT_MODEL : CLAUDE_DEFAULT_MODEL);

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

export function resolveReviewerProvider(profile: Profile): ModelProvider {
  return profile.modelProvider ?? 'anthropic';
}

export function resolveReviewerModel(profile: Profile, logger?: Logger): string {
  const reviewerRuntime = resolvePodRuntime(profile, profile.defaultRuntime ?? undefined, logger);
  const requestedModel = profile.reviewerModel || profile.defaultModel || undefined;

  if (requestedModel) {
    return resolvePodModel(profile, requestedModel, reviewerRuntime, logger);
  }

  return reviewerRuntime === 'codex' ? CODEX_DEFAULT_MODEL : CLAUDE_REVIEWER_MODEL;
}
