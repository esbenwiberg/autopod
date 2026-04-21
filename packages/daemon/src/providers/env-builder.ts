import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type { MaxCredentials, Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import { refreshOAuthToken } from './credential-refresh.js';
import type { ProviderEnvResult } from './types.js';

type ContainerFile = ProviderEnvResult['containerFiles'][number];

const CONTAINER_WORK_DIR = '/workspace';

/**
 * Returns the Claude Code config files to inject into every container:
 *
 *  ~/.claude.json       — skips onboarding, disclaimer, and pre-accepts folder trust
 *  ~/.claude/settings.json — sets theme to dark, disables auto-updater
 *
 * Exported so callers can write these unconditionally, independent of the
 * provider credential refresh (which can fail transiently on 429/401 and
 * must not take the UX config down with it).
 */
export function buildClaudeConfigFiles(): ContainerFile[] {
  const claudeJson = JSON.stringify(
    {
      hasCompletedOnboarding: true,
      hasAcknowledgedDisclaimer: true,
      projects: {
        [CONTAINER_WORK_DIR]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
          projectOnboardingSeenCount: 1,
        },
      },
    },
    null,
    2,
  );

  const settingsJson = JSON.stringify({ theme: 'dark', autoUpdaterStatus: 'disabled' }, null, 2);

  return [
    { path: `${CONTAINER_HOME_DIR}/.claude.json`, content: claudeJson },
    { path: `${CONTAINER_HOME_DIR}/.claude/settings.json`, content: settingsJson },
  ];
}

export interface BuildProviderEnvOptions {
  /**
   * For MAX/PRO: attempt the daemon-side OAuth refresh, but fall back to the
   * stored credentials on failure instead of throwing. Use for workspace pods
   * where Claude CLI inside the container can refresh on its own — a transient
   * 429/5xx/network blip at the OAuth endpoint must not leave the pod logged out.
   *
   * When false (default): refresh failure throws, failing the whole provisioning
   * step. Right for auto pods where we need verified-valid creds up-front because
   * the agent has no way to interactively log in.
   */
  bestEffortRefresh?: boolean;
}

/**
 * Build provider-specific environment variables and credential files for a pod.
 *
 * Returns env vars, files to write to the container, and whether post-exec
 * credential persistence is needed (for MAX/PRO token rotation).
 */
export async function buildProviderEnv(
  profile: Profile,
  _sessionId: string,
  logger: Logger,
  options: BuildProviderEnvOptions = {},
): Promise<ProviderEnvResult> {
  const provider = profile.modelProvider;

  switch (provider) {
    case 'anthropic':
      return buildAnthropicEnv();

    case 'max':
      return buildMaxEnv(profile, logger, options.bestEffortRefresh ?? false);

    case 'foundry':
      return buildFoundryEnv(profile);

    case 'copilot':
      return buildCopilotEnv(profile);

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
    containerFiles: buildClaudeConfigFiles(),
    requiresPostExecPersistence: false,
  };
}

/**
 * MAX/PRO OAuth provider.
 *
 * 1. Refreshes the access token if near expiry. When `bestEffortRefresh` is set
 *    (workspace pods), refresh failures fall back to the stored credentials so
 *    Claude CLI inside the container can handle its own refresh. Otherwise the
 *    failure throws and fails provisioning.
 * 2. Builds a `.claude/.credentials.json` file for the container
 * 3. Sets HOME env to a temp dir so Claude Code finds the credentials
 * 4. Does NOT set ANTHROPIC_API_KEY (forces OAuth path)
 */
async function buildMaxEnv(
  profile: Profile,
  logger: Logger,
  bestEffortRefresh: boolean,
): Promise<ProviderEnvResult> {
  const creds = profile.providerCredentials;

  if (!creds || creds.provider !== 'max') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=max but missing or mismatched providerCredentials`,
    );
  }

  let refreshed: MaxCredentials;
  if (bestEffortRefresh) {
    try {
      refreshed = await refreshOAuthToken(creds, logger);
    } catch (err) {
      logger.warn(
        { err },
        'OAuth token refresh failed — falling back to stored credentials. Claude CLI in the container will retry the refresh on first use.',
      );
      refreshed = creds;
    }
  } else {
    refreshed = await refreshOAuthToken(creds, logger);
  }

  // Build the credentials file that Claude Code expects at ~/.claude/.credentials.json.
  // All fields must be preserved — claude 2.1.80+ requires scopes/subscriptionType
  // to be present or it treats the user as logged out locally (no API call made).
  const credentialsFile = JSON.stringify(
    {
      claudeAiOauth: {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(refreshed.expiresAt).getTime(),
        ...(refreshed.scopes && { scopes: refreshed.scopes }),
        ...(refreshed.subscriptionType && { subscriptionType: refreshed.subscriptionType }),
        ...(refreshed.rateLimitTier && { rateLimitTier: refreshed.rateLimitTier }),
      },
    },
    null,
    2,
  );

  // Write credentials to the autopod user's home directory.
  const credPath = `${CONTAINER_HOME_DIR}/.claude/.credentials.json`;

  return {
    env: {},
    containerFiles: [{ path: credPath, content: credentialsFile }, ...buildClaudeConfigFiles()],
    requiresPostExecPersistence: true,
  };
}

/**
 * GitHub Copilot CLI provider — injects COPILOT_GITHUB_TOKEN env var.
 */
function buildCopilotEnv(profile: Profile): ProviderEnvResult {
  const creds = profile.providerCredentials;

  if (!creds || creds.provider !== 'copilot') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=copilot but missing or mismatched providerCredentials`,
    );
  }

  const env: Record<string, string> = { COPILOT_GITHUB_TOKEN: creds.token };
  if (creds.model) env.COPILOT_MODEL = creds.model;

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    requiresPostExecPersistence: false,
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
    containerFiles: buildClaudeConfigFiles(),
    requiresPostExecPersistence: false,
  };
}
