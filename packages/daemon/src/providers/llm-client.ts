import Anthropic from '@anthropic-ai/sdk';
import type { Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import { getAzureToken } from './azure-token.js';
import { refreshOAuthToken } from './credential-refresh.js';

const FOUNDRY_TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

// Beta header required when calling api.anthropic.com with a Claude MAX/Pro
// OAuth bearer token instead of an API key. Mirrors what Claude Code sends.
const MAX_OAUTH_BETA = 'oauth-2025-04-20';

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

function resolveModelId(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

export interface ProfileLlmClient {
  client: Anthropic;
  /** Resolved Anthropic model id (alias expanded). */
  model: string;
}

/**
 * Build an Anthropic SDK client from a profile's provider credentials so
 * daemon-side LLM helpers (PR description, auto-commit message, etc.) use the
 * same auth path the agent does — no separate `ANTHROPIC_API_KEY` required.
 *
 * Returns `null` when the profile uses a provider that doesn't expose an
 * Anthropic-compatible Messages endpoint (`copilot`, `foundry` openai surface)
 * or when credentials are missing. Callers fall back to template output.
 */
export async function createProfileAnthropicClient(
  profile: Profile,
  podModel: string,
  logger: Logger,
): Promise<ProfileLlmClient | null> {
  const provider = profile.modelProvider;
  const creds = profile.providerCredentials;
  const model = resolveModelId(podModel);

  // Legacy profiles with no modelProvider set: try the daemon env var.
  if (!provider) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    return { client: new Anthropic({ apiKey }), model };
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn(
        { profile: profile.name },
        'Profile uses anthropic provider but daemon ANTHROPIC_API_KEY is unset — daemon-side LLM helpers fall back to templates',
      );
      return null;
    }
    return { client: new Anthropic({ apiKey }), model };
  }

  if (provider === 'max') {
    if (!creds || creds.provider !== 'max') {
      logger.warn(
        { profile: profile.name },
        'Profile uses max provider but credentials are missing — daemon-side LLM helpers fall back to templates',
      );
      return null;
    }
    const refreshed = await refreshOAuthToken(creds, logger);
    return {
      client: new Anthropic({
        authToken: refreshed.accessToken,
        defaultHeaders: { 'anthropic-beta': MAX_OAUTH_BETA },
      }),
      model,
    };
  }

  if (provider === 'foundry') {
    if (!creds || creds.provider !== 'foundry') {
      logger.warn(
        { profile: profile.name },
        'Profile uses foundry provider but credentials are missing — daemon-side LLM helpers fall back to templates',
      );
      return null;
    }
    if ((creds.apiSurface ?? 'anthropic') !== 'anthropic') {
      logger.debug(
        { profile: profile.name },
        'Profile uses foundry openai surface — daemon-side LLM helpers fall back to templates',
      );
      return null;
    }
    const apiKey = creds.apiKey ?? (await getAzureToken(FOUNDRY_TOKEN_SCOPE, logger)).token;
    return {
      client: new Anthropic({ apiKey, baseURL: creds.endpoint }),
      model,
    };
  }

  // copilot — no daemon-callable Anthropic-compatible API
  logger.debug(
    { profile: profile.name, provider },
    'Profile provider is not daemon-callable — LLM helpers fall back to templates',
  );
  return null;
}
