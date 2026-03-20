/**
 * Model provider types.
 *
 * Determines how the daemon authenticates with the AI backend for a session:
 * - `anthropic`: API key from daemon env (default, backwards-compatible)
 * - `max`: Claude consumer subscription (MAX/PRO) via OAuth credentials file
 * - `foundry`: Azure Foundry deployment with endpoint + project config
 */
export type ModelProvider = 'anthropic' | 'max' | 'foundry';

/** Anthropic API key provider — uses daemon env `ANTHROPIC_API_KEY`. No per-profile creds. */
export interface AnthropicCredentials {
  provider: 'anthropic';
}

/**
 * Claude MAX/PRO OAuth credentials.
 *
 * Claude Code reads these from `~/.claude/.credentials.json` when no API key is set.
 * The daemon handles token refresh pre-flight and persists rotated tokens post-exec.
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

export type ProviderCredentials = AnthropicCredentials | MaxCredentials | FoundryCredentials;
