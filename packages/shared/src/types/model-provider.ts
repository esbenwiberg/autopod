/**
 * Model provider types.
 *
 * Determines how the daemon authenticates with the AI backend for a session:
 * - `anthropic`: API key from daemon env (default, backwards-compatible)
 * - `max`: Claude consumer subscription (MAX/PRO) via OAuth credentials file
 * - `openai`: OpenAI API key from daemon env, used by the Codex runtime
 * - `foundry`: Azure Foundry deployment with endpoint + project config
 * - `copilot`: GitHub Copilot CLI via OAuth token (`COPILOT_GITHUB_TOKEN`)
 * - `openrouter`: OpenRouter aggregator — uses Codex runtime with a custom base URL.
 *   Experimental: only models that pass the spike telemetry contract should be used.
 * - `pi`: Pi subscription OAuth entry captured from Pi auth.json.
 */
export type ModelProvider =
  | 'anthropic'
  | 'max'
  | 'openai'
  | 'foundry'
  | 'copilot'
  | 'openrouter'
  | 'pi';

/** Anthropic API key provider — uses daemon env `ANTHROPIC_API_KEY`. No per-profile creds. */
export interface AnthropicCredentials {
  provider: 'anthropic';
}

/**
 * OpenAI provider for the Codex runtime.
 *
 * When `authJson` is absent, the daemon falls back to `OPENAI_API_KEY` from its env.
 * When present, it is an opaque Codex `auth.json` captured from `codex login`
 * (ChatGPT/Pro auth) and injected into `~/.codex/auth.json` in the pod.
 */
export interface OpenAiCredentials {
  provider: 'openai';
  authMode?: 'chatgpt';
  authJson?: string;
}

/**
 * Claude MAX/PRO OAuth credentials captured from the legacy
 * `~/.claude/.credentials.json` flow.
 *
 * Claude Code reads these from `~/.claude/.credentials.json` when no API key is
 * set. The daemon handles token refresh pre-flight and persists rotated tokens
 * post-exec.
 *
 * All fields from the `claudeAiOauth` object must be preserved — claude 2.1.80+
 * requires `scopes` and `subscriptionType` to be present or it treats the user as
 * logged out even with a valid, non-expired access token.
 */
export interface MaxRefreshCredentials {
  provider: 'max';
  /** OAuth access token (short-lived). */
  accessToken: string;
  /** OAuth refresh token (rotated by Claude on use). */
  refreshToken: string;
  /** ISO datetime when accessToken expires. */
  expiresAt: string;
  /** OAuth client ID — defaults to Claude Code's well-known client ID. */
  clientId?: string;
  /** OAuth scopes granted to this token. Required by claude 2.1.80+. */
  scopes?: string[];
  /** Subscription tier (e.g. "max", "pro"). Required by claude 2.1.80+. */
  subscriptionType?: string;
  /** Rate limit tier. Preserved for completeness. */
  rateLimitTier?: string;
}

/**
 * Claude MAX/PRO long-lived OAuth token produced by `claude setup-token`.
 *
 * Current Claude Code on macOS stores interactive auth in Keychain instead of a
 * portable `.credentials.json`; setup-token is the supported unattended path.
 * The daemon injects this as `CLAUDE_CODE_OAUTH_TOKEN` for the Claude CLI.
 */
export interface MaxSetupTokenCredentials {
  provider: 'max';
  authMode?: 'setup-token';
  /** Long-lived OAuth token for Claude Code CLI unattended auth. */
  oauthToken: string;
}

export type MaxCredentials = MaxRefreshCredentials | MaxSetupTokenCredentials;

/**
 * Foundry exposes models behind two protocol surfaces:
 *  - `anthropic` — Anthropic Messages API (Claude on Foundry, or any backend
 *    behind an Anthropic-compatible endpoint). Default — preserves the
 *    legacy single-surface behavior.
 *  - `openai` — OpenAI Chat/Responses API (GPT, plus any model the deployment
 *    exposes via the OpenAI-compatible surface). Routes through the Codex
 *    runtime instead of the Claude CLI.
 */
export type FoundryApiSurface = 'anthropic' | 'openai';

/**
 * Azure Foundry provider credentials.
 *
 * Auth is either via `apiKey` (encrypted at rest) or — when omitted — a bearer
 * token acquired at exec time from `DefaultAzureCredential` (managed identity
 * in hosted envs, `az login` session locally). The bearer token never leaves
 * the daemon's `getAzureToken` helper plus the secret-file write into the
 * container.
 */
export interface FoundryCredentials {
  provider: 'foundry';
  /** Foundry endpoint URL (Azure-AI / Cognitive Services region root). */
  endpoint: string;
  /** Foundry project identifier. */
  projectId: string;
  /** Optional API key. Omit to use managed identity / az-login bearer tokens. */
  apiKey?: string;
  /**
   * Protocol surface the deployment exposes. Defaults to `anthropic` when
   * unset so existing profiles keep their pre-existing behavior.
   */
  apiSurface?: FoundryApiSurface;
  /** Optional API version pinned by the deployment (used for `openai` surface). */
  apiVersion?: string;
}

/**
 * GitHub Copilot CLI credentials.
 *
 * Token is injected as `COPILOT_GITHUB_TOKEN` env var when spawning the runtime.
 * Supported token types: OAuth (`gho_`), fine-grained PAT (`github_pat_`), GitHub App (`ghu_`).
 * Classic PATs (`ghp_`) are not supported by Copilot CLI.
 */
export interface CopilotCredentials {
  provider: 'copilot';
  /** GitHub OAuth or PAT token. Does not expire unless revoked. */
  token: string;
  /** Copilot model ID (e.g. "claude-3.5-sonnet", "gpt-4o"). Omits --model flag if not set. */
  model?: string;
}

/**
 * OpenRouter aggregator provider.
 *
 * Routes the Codex runtime through OpenRouter's OpenAI-compatible endpoint.
 * The `apiKey` is written to a secret file; `OPENAI_BASE_URL` is set to the
 * OpenRouter endpoint so Codex resolves arbitrary provider/model strings
 * (e.g. "deepseek/deepseek-r1", "minimax/minimax-01").
 *
 * Experimental — only use models that have passed the spike telemetry contract.
 * Set `defaultRuntime: 'codex'` on the profile.
 */
export interface OpenRouterCredentials {
  provider: 'openrouter';
  /** OpenRouter API key. */
  apiKey: string;
  /** Override the base URL. Defaults to `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
}

export type PiOAuthProviderId = 'anthropic' | 'openai-codex' | 'github-copilot';

export interface PiOAuthCredentials {
  provider: 'pi';
  providerId: PiOAuthProviderId;
  /** Opaque provider entry extracted from Pi's auth.json for providerId. */
  credential: Record<string, unknown>;
}

/**
 * Static API-key credentials for a manifest-backed generic Pi provider.
 *
 * `provider` identifies the credential mechanism, while `providerId` identifies
 * the product/account in the compiled provider catalog.
 */
export interface GenericApiKeyCredentials {
  provider: 'api-key';
  providerId: string;
  apiKey: string;
}

export type ProviderCredentials =
  | AnthropicCredentials
  | OpenAiCredentials
  | MaxCredentials
  | FoundryCredentials
  | CopilotCredentials
  | OpenRouterCredentials
  | PiOAuthCredentials
  | GenericApiKeyCredentials;
