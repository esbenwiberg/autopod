import Anthropic from '@anthropic-ai/sdk';
import type {
  MaxCredentials,
  MaxRefreshCredentials,
  MaxSetupTokenCredentials,
  ModelProvider,
  Profile,
  ProviderCredentials,
} from '@autopod/shared';
import type { Logger } from 'pino';
import { getAzureToken } from './azure-token.js';
import { refreshOAuthToken } from './credential-refresh.js';

const FOUNDRY_TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

// Beta header required when calling api.anthropic.com with a Claude MAX/Pro
// OAuth bearer token instead of an API key. Mirrors what Claude Code sends.
const MAX_OAUTH_BETA = 'oauth-2025-04-20';

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

function isMaxSetupTokenCredentials(creds: MaxCredentials): creds is MaxSetupTokenCredentials {
  return (
    'oauthToken' in creds && typeof creds.oauthToken === 'string' && creds.oauthToken.length > 0
  );
}

function isMaxRefreshCredentials(creds: MaxCredentials): creds is MaxRefreshCredentials {
  return (
    'accessToken' in creds &&
    'refreshToken' in creds &&
    'expiresAt' in creds &&
    typeof creds.accessToken === 'string' &&
    typeof creds.refreshToken === 'string' &&
    typeof creds.expiresAt === 'string'
  );
}

export function resolveAnthropicModelId(model: string): string {
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

export async function createProviderAnthropicClient(
  input: {
    provider?: ModelProvider | null;
    credentials?: ProviderCredentials | null;
    model: string;
    profileName?: string;
  },
  logger: Logger,
): Promise<ProfileLlmClientResult> {
  const { provider, credentials: creds } = input;
  const profileName = input.profileName ?? 'unknown';
  const model = resolveAnthropicModelId(input.model);

  // Legacy profiles with no modelProvider set: try the daemon env var.
  if (!provider) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn(
        { profile: profileName, reason: 'no_anthropic_api_key' },
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
        { profile: profileName, reason: 'no_anthropic_api_key' },
        'Profile uses anthropic provider but daemon ANTHROPIC_API_KEY is unset — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'no_anthropic_api_key' };
    }
    return { ok: true, client: new Anthropic({ apiKey }), model };
  }

  if (provider === 'max') {
    if (!creds || creds.provider !== 'max') {
      logger.warn(
        { profile: profileName, reason: 'no_credentials' },
        'Profile uses max provider but credentials are missing — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'no_credentials' };
    }
    const authToken = isMaxSetupTokenCredentials(creds)
      ? creds.oauthToken
      : isMaxRefreshCredentials(creds)
        ? (await refreshOAuthToken(creds, logger)).accessToken
        : null;
    if (!authToken) {
      logger.warn(
        { profile: profileName, reason: 'no_credentials' },
        'Profile uses max provider but credentials are incomplete — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'no_credentials' };
    }
    return {
      ok: true,
      client: new Anthropic({
        authToken,
        defaultHeaders: { 'anthropic-beta': MAX_OAUTH_BETA },
      }),
      model,
    };
  }

  if (provider === 'foundry') {
    if (!creds || creds.provider !== 'foundry') {
      logger.warn(
        { profile: profileName, reason: 'no_credentials' },
        'Profile uses foundry provider but credentials are missing — daemon-side LLM helpers fall back to templates',
      );
      return { ok: false, reason: 'no_credentials' };
    }
    if ((creds.apiSurface ?? 'anthropic') !== 'anthropic') {
      logger.warn(
        { profile: profileName, provider, reason: 'foundry_openai_surface' },
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

  // openai/copilot — no daemon-callable Anthropic-compatible API
  logger.warn(
    { profile: profileName, provider, reason: 'provider_not_callable' },
    'Profile provider is not daemon-callable — LLM helpers fall back to templates',
  );
  return { ok: false, reason: 'provider_not_callable' };
}

/**
 * Build an Anthropic SDK client from a profile's provider credentials so
 * daemon-side LLM helpers (PR description, auto-commit message, etc.) use the
 * same auth path the agent does — no separate `ANTHROPIC_API_KEY` required.
 *
 * Returns `{ ok: false, reason }` when the profile uses a provider that
 * doesn't expose an Anthropic-compatible Messages endpoint (`openai`, `copilot`,
 * `foundry` openai surface) or when credentials are missing. Callers fall
 * back to template output and propagate the reason to the user.
 */
export async function createProfileAnthropicClient(
  profile: Profile,
  podModel: string,
  logger: Logger,
): Promise<ProfileLlmClientResult> {
  return createProviderAnthropicClient(
    {
      provider: profile.modelProvider,
      credentials: profile.providerCredentials,
      model: podModel,
      profileName: profile.name,
    },
    logger,
  );
}
