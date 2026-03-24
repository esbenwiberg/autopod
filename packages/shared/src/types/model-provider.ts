/**
 * Model provider types.
 *
 * Determines how the daemon authenticates with the AI backend for a session:
 * - `anthropic`: API key from daemon env (default, backwards-compatible)
 * - `max`: Claude consumer subscription (MAX/PRO) via OAuth credentials file
 * - `foundry`: Azure Foundry deployment with endpoint + project config
 * - `copilot`: GitHub Copilot CLI via OAuth token (`COPILOT_GITHUB_TOKEN`)
 */
export type ModelProvider = 'anthropic' | 'max' | 'foundry' | 'copilot';

/** Anthropic API key provider — uses daemon env `ANTHROPIC_API_KEY`. No per-profile creds. */
export interface AnthropicCredentials {
  provider: 'anthropic';
}

/**
 * Claude MAX/PRO OAuth credentials.
 *
 * Claude Code reads these from `~/.claude/.credentials.json` when no API key is set.
 * The daemon handles token refresh pre-flight and persists rotated tokens post-exec.
 *
 * All fields from the `claudeAiOauth` object must be preserved — claude 2.1.80+
 * requires `scopes` and `subscriptionType` to be present or it treats the user as
 * logged out even with a valid, non-expired access token.
 */
export interface MaxCredentials {
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
 * Azure Foundry provider credentials.
 *
 * Sets `CLAUDE_CODE_USE_FOUNDRY=1` plus endpoint config env vars.
 */
export interface FoundryCredentials {
  provider: 'foundry';
  /** Azure Foundry endpoint URL. */
  endpoint: string;
  /** Foundry project identifier. */
  projectId: string;
  /** Optional API key (omit if using managed identity). */
  apiKey?: string;
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
}

export type ProviderCredentials =
  | AnthropicCredentials
  | MaxCredentials
  | FoundryCredentials
  | CopilotCredentials;
