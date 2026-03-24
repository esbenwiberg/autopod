import type { MaxCredentials, Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import { refreshOAuthToken } from './credential-refresh.js';
import type { ProviderEnvResult } from './types.js';

/**
 * Build provider-specific environment variables and credential files for a session.
 *
 * Returns env vars, files to write to the container, and whether post-exec
 * credential persistence is needed (for MAX/PRO token rotation).
 */
export async function buildProviderEnv(
  profile: Profile,
  _sessionId: string,
  logger: Logger,
): Promise<ProviderEnvResult> {
  const provider = profile.modelProvider;

  switch (provider) {
    case 'anthropic':
      return buildAnthropicEnv();

    case 'max':
      return buildMaxEnv(profile, logger);

    case 'foundry':
      return buildFoundryEnv(profile);

    default:
      // Exhaustiveness check
      throw new Error(`Unknown model provider: ${provider as string}`);
  }
}

/**
 * Anthropic API key provider — uses daemon env var.
 */
function buildAnthropicEnv(): ProviderEnvResult {
  const env: Record<string, string> = {};

  if (process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }

  return {
    env,
    containerFiles: [],
    requiresPostExecPersistence: false,
  };
}

/**
 * MAX/PRO OAuth provider.
 *
 * 1. Refreshes the access token if near expiry
 * 2. Builds a `.claude/.credentials.json` file for the container
 * 3. Sets HOME env to a temp dir so Claude Code finds the credentials
 * 4. Does NOT set ANTHROPIC_API_KEY (forces OAuth path)
 */
async function buildMaxEnv(profile: Profile, logger: Logger): Promise<ProviderEnvResult> {
  const creds = profile.providerCredentials;

  if (!creds || creds.provider !== 'max') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=max but missing or mismatched providerCredentials`,
    );
  }

  // Pre-flight token refresh
  const refreshed = await refreshOAuthToken(creds, logger);

  // Build the credentials file that Claude Code expects at ~/.claude/.credentials.json
  const credentialsFile = JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(refreshed.expiresAt).getTime(),
      },
    },
    null,
    2,
  );

  // Write credentials to the node user's actual home directory.
  // /home/node is the container's real HOME — no HOME override needed.
  const homeDir = '/home/node';
  const credPath = `${homeDir}/.claude/.credentials.json`;

  // Also write a minimal config to skip onboarding prompts
  const configFile = JSON.stringify(
    {
      hasCompletedOnboarding: true,
      hasAcknowledgedDisclaimer: true,
    },
    null,
    2,
  );
  const configPath = `${homeDir}/.claude/config.json`;

  return {
    env: {},
    containerFiles: [
      { path: credPath, content: credentialsFile },
      { path: configPath, content: configFile },
    ],
    requiresPostExecPersistence: true,
  };
}

/**
 * Azure Foundry provider — sets env vars for Foundry endpoint.
 */
function buildFoundryEnv(profile: Profile): ProviderEnvResult {
  const creds = profile.providerCredentials;

  if (!creds || creds.provider !== 'foundry') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=foundry but missing or mismatched providerCredentials`,
    );
  }

  const env: Record<string, string> = {
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_BASE_URL: creds.endpoint,
    CLAUDE_FOUNDRY_PROJECT: creds.projectId,
  };

  if (creds.apiKey) {
    env.ANTHROPIC_API_KEY = creds.apiKey;
  }

  return {
    env,
    containerFiles: [],
    requiresPostExecPersistence: false,
  };
}
