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
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { type CredentialOwner, resolveProviderAuth } from './auth-resolution.js';
import { getAzureToken } from './azure-token.js';
import { refreshAndPersistMaxCredentials } from './credential-persistence.js';
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
  | 'provider_not_callable'
  | 'refresh_failed';

/**
 * Optional stores that let daemon-side LLM helpers resolve the *effective*
 * credentials a profile authenticates with — the same path the agent container
 * uses (`resolveProviderAuth`). Without these, callers fall back to the
 * profile's own `providerCredentials` column, which is stale (or absent) for
 * profiles linked to a shared provider account.
 */
export interface ProfileLlmClientDeps {
  profileStore?: ProfileStore;
  providerAccountStore?: ProviderAccountStore;
}

function isMaxRefreshProviderCreds(
  creds: ProviderCredentials | null | undefined,
): creds is MaxRefreshCredentials {
  return creds?.provider === 'max' && isMaxRefreshCredentials(creds);
}

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
    let authToken: string | null;
    if (isMaxSetupTokenCredentials(creds)) {
      authToken = creds.oauthToken;
    } else if (isMaxRefreshCredentials(creds)) {
      try {
        // Refresh here is best-effort and non-persisting. Callers that pass a
        // profileStore (via createProfileAnthropicClient) refresh-and-persist
        // under the owner lock first, leaving this a no-op grace-window read.
        authToken = (await refreshOAuthToken(creds, logger)).accessToken;
      } catch (err) {
        logger.warn(
          { profile: profileName, provider, reason: 'refresh_failed', err },
          'MAX OAuth refresh failed for daemon-side LLM helper — falling back to templates',
        );
        return { ok: false, reason: 'refresh_failed' };
      }
    } else {
      authToken = null;
    }
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
    let apiKey: string;
    try {
      apiKey = creds.apiKey ?? (await getAzureToken(FOUNDRY_TOKEN_SCOPE, logger)).token;
    } catch (err) {
      logger.warn(
        { profile: profileName, provider, reason: 'refresh_failed', err },
        'Foundry token acquisition failed for daemon-side LLM helper — falling back to templates',
      );
      return { ok: false, reason: 'refresh_failed' };
    }
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
  deps: ProfileLlmClientDeps = {},
): Promise<ProfileLlmClientResult> {
  let provider = profile.modelProvider;
  let credentials = profile.providerCredentials;
  let owner: CredentialOwner | null = null;

  // Resolve the *effective* credentials the agent actually authenticates with.
  // For profiles linked to a shared provider account the live, rotation-tracked
  // tokens live on the account — the profile's own `providerCredentials` column
  // is a stale snapshot (or null) left from before the link. Only attempt this
  // when a provider-account store is available: resolveProviderAuth throws for a
  // linked profile without one.
  if (deps.profileStore || deps.providerAccountStore) {
    try {
      const auth = resolveProviderAuth(profile, deps);
      provider = auth.provider;
      credentials = auth.credentials;
      owner = auth.owner;
    } catch (err) {
      logger.warn(
        { profile: profile.name, err },
        'Failed to resolve provider auth for daemon-side LLM helper — falling back to profile credentials',
      );
    }
  }

  // MAX rotates refresh tokens on every use. Refresh and persist under the
  // credential-owner lock so this daemon-side call doesn't burn the shared
  // refresh token that the next pod (or the container readback) depends on.
  if (provider === 'max' && deps.profileStore && isMaxRefreshProviderCreds(credentials)) {
    try {
      const refreshed = await refreshAndPersistMaxCredentials(
        deps.profileStore,
        profile.name,
        credentials,
        logger,
        { providerAccountStore: deps.providerAccountStore, owner: owner ?? undefined },
      );
      credentials = refreshed.credentials;
    } catch (err) {
      logger.warn(
        { profile: profile.name, reason: 'refresh_failed', err },
        'MAX credential refresh/persist failed for daemon-side LLM helper — falling back to templates',
      );
      return { ok: false, reason: 'refresh_failed' };
    }
  }

  return createProviderAnthropicClient(
    {
      provider,
      credentials,
      model: podModel,
      profileName: profile.name,
    },
    logger,
  );
}
