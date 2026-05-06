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
 * Stable reason codes returned when a profile cannot back a daemon-side LLM
 * call. Surfaced to callers (PR title/narrative, auto-commit message) so they
 * can stamp the same code into the PR body footer / pod activity log.
 */
export type ProfileLlmClientUnavailableReason =
  | 'no_anthropic_api_key'
  | 'no_credentials'
  | 'foundry_openai_surface'
  | 'provider_not_callable';

export type ProfileLlmClientResult =
  | { ok: true; client: Anthropic; model: string }
  | { ok: false; reason: ProfileLlmClientUnavailableReason };

/**
 * Build an Anthropic SDK client from a profile's provider credentials so
 * daemon-side LLM helpers (PR description, auto-commit message, etc.) use the
 * same auth path the agent does — no separate `ANTHROPIC_API_KEY` required.
 *
 * Returns `{ ok: false, reason }` when the profile uses a provider that
 * doesn't expose an Anthropic-compatible Messages endpoint (`copilot`,
 * `foundry` openai surface) or when credentials are missing. Callers fall
 * back to template output and propagate the reason to the user.
 */
export async function createProfileAnthropicClient(
  profile: Profile,
  podModel: string,
  logger: Logger,
): Promise<ProfileLlmClientResult> {
  const provider = profile.modelProvider;
  const creds = profile.providerCredentials;
  const model = resolveModelId(podModel);

  // Legacy profiles with no modelProvider set: try the daemon env var.
  if (!provider) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn(
        { profile: profile.name, reason: 'no_anthropic_api_key' },
        'Profile has no modelProvider and daemon ANTHROPIC_API_KEY is unset — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'no_anthropic_api_key' };
    }
    return { ok: true, client: new Anthropic({ apiKey }), model };
  }

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn(
        { profile: profile.name, reason: 'no_anthropic_api_key' },
        'Profile uses anthropic provider but daemon ANTHROPIC_API_KEY is unset — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'no_anthropic_api_key' };
    }
    return { ok: true, client: new Anthropic({ apiKey }), model };
  }

  if (provider === 'max') {
    if (!creds || creds.provider !== 'max') {
      logger.warn(
        { profile: profile.name, reason: 'no_credentials' },
        'Profile uses max provider but credentials are missing — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'no_credentials' };
    }
    const refreshed = await refreshOAuthToken(creds, logger);
    return {
      ok: true,
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
        { profile: profile.name, reason: 'no_credentials' },
        'Profile uses foundry provider but credentials are missing — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'no_credentials' };
    }
    if ((creds.apiSurface ?? 'anthropic') !== 'anthropic') {
      logger.warn(
        { profile: profile.name, provider, reason: 'foundry_openai_surface' },
        'Profile uses foundry openai surface — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'foundry_openai_surface' };
    }
    const apiKey = creds.apiKey ?? (await getAzureToken(FOUNDRY_TOKEN_SCOPE, logger)).token;
    return {
      ok: true,
      client: new Anthropic({ apiKey, baseURL: creds.endpoint }),
      model,
    };
  }

  // copilot — no daemon-callable Anthropic-compatible API
  logger.warn(
    { profile: profile.name, provider, reason: 'provider_not_callable' },
    'Profile provider is not daemon-callable — LLM helpers fall back to templates',
  );
  return { ok: false, reason: 'provider_not_callable' };
}
