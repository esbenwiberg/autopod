import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type { FoundryCredentials, Profile } from '@autopod/shared';
import type { Logger } from 'pino';
import { getAzureToken } from './azure-token.js';
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
 * Exported so pod-manager can write these for workspace pods independently of
 * provider credential injection — workspace pods don't pre-seed credentials
 * (users /login manually), but they still need these UX files written to skip
 * the first-run theme/trust/disclaimer prompts every time they run `claude`.
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

  const settingsJson = JSON.stringify(
    {
      theme: 'dark',
      autoUpdaterStatus: 'disabled',
      env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
    },
    null,
    2,
  );

  return [
    { path: `${CONTAINER_HOME_DIR}/.claude.json`, content: claudeJson },
    { path: `${CONTAINER_HOME_DIR}/.claude/settings.json`, content: settingsJson },
  ];
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
): Promise<ProviderEnvResult> {
  const provider = profile.modelProvider;

  switch (provider) {
    case 'anthropic':
      return buildAnthropicEnv();

    case 'max':
      return buildMaxEnv(profile, logger);

    case 'foundry':
      return buildFoundryEnv(profile, logger);

    case 'copilot':
      return buildCopilotEnv(profile);

    default:
      // Exhaustiveness check
      throw new Error(`Unknown model provider: ${provider as string}`);
  }
}

const SECRET_DIR = '/run/autopod';

/**
 * Anthropic API key provider — uses daemon env var.
 * The key is written to a 0400 secret file inside the container; the exec env
 * carries only the _FILE pointer so the raw key never appears in env dumps.
 */
function buildAnthropicEnv(): ProviderEnvResult {
  const env: Record<string, string> = {};
  const secretFiles: ProviderEnvResult['secretFiles'] = [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const filePath = `${SECRET_DIR}/anthropic-api-key`;
    secretFiles.push({ path: filePath, content: apiKey });
    env.ANTHROPIC_API_KEY_FILE = filePath;
  }

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles,
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
    secretFiles: [],
    requiresPostExecPersistence: true,
  };
}

/**
 * GitHub Copilot CLI provider — token written to a 0400 secret file; env carries
 * only COPILOT_GITHUB_TOKEN_FILE so the raw token stays out of env dumps.
 */
function buildCopilotEnv(profile: Profile): ProviderEnvResult {
  const creds = profile.providerCredentials;

  if (!creds || creds.provider !== 'copilot') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=copilot but missing or mismatched providerCredentials`,
    );
  }

  const filePath = `${SECRET_DIR}/copilot-token`;
  const env: Record<string, string> = { COPILOT_GITHUB_TOKEN_FILE: filePath };
  if (creds.model) env.COPILOT_MODEL = creds.model;

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles: [{ path: filePath, content: creds.token }],
    requiresPostExecPersistence: false,
  };
}

/**
 * Azure Foundry scope for `cognitiveservices.azure.com` data-plane access.
 * Used when no apiKey is configured — the daemon acquires a bearer token via
 * `DefaultAzureCredential` (managed identity in hosted envs, az-login session
 * locally) and writes it to a secret file the agent CLI reads as its API key.
 *
 * Tokens last ~60-90 minutes; long-running pods refresh them via
 * `getResumeEnv()` on each agent resume — same approach as MAX OAuth.
 */
const FOUNDRY_TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

/**
 * Azure Foundry provider — sets endpoint env vars and writes either the
 * configured API key or a freshly-acquired Entra bearer token into the
 * container as a secret file. Branches on `apiSurface` so OpenAI-protocol
 * deployments (GPT, Qwen, etc.) route through Codex's env vars instead of
 * Claude's.
 */
async function buildFoundryEnv(profile: Profile, logger: Logger): Promise<ProviderEnvResult> {
  const creds = profile.providerCredentials;

  if (!creds || creds.provider !== 'foundry') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=foundry but missing or mismatched providerCredentials`,
    );
  }

  const surface = creds.apiSurface ?? 'anthropic';
  const secretValue = await resolveFoundrySecret(creds, logger);

  return surface === 'openai'
    ? buildFoundryOpenAiEnv(creds, secretValue)
    : buildFoundryAnthropicEnv(creds, secretValue);
}

/**
 * Acquire the bearer value to inject — explicit apiKey wins; otherwise pull
 * a short-lived Entra token via the shared helper. Returns `null` only when
 * an apiKey was explicitly intended to be omitted AND token acquisition
 * fails — that's a fatal misconfiguration, so we throw instead of silently
 * spawning an unauthenticated pod.
 */
async function resolveFoundrySecret(creds: FoundryCredentials, logger: Logger): Promise<string> {
  if (creds.apiKey) return creds.apiKey;

  const token = await getAzureToken(FOUNDRY_TOKEN_SCOPE, logger);
  return token.token;
}

function buildFoundryAnthropicEnv(creds: FoundryCredentials, secret: string): ProviderEnvResult {
  const filePath = `${SECRET_DIR}/foundry-api-key`;
  const env: Record<string, string> = {
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_BASE_URL: creds.endpoint,
    CLAUDE_FOUNDRY_PROJECT: creds.projectId,
    ANTHROPIC_API_KEY_FILE: filePath,
  };

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles: [{ path: filePath, content: secret }],
    requiresPostExecPersistence: false,
  };
}

function buildFoundryOpenAiEnv(creds: FoundryCredentials, secret: string): ProviderEnvResult {
  const filePath = `${SECRET_DIR}/foundry-openai-key`;
  const env: Record<string, string> = {
    OPENAI_BASE_URL: creds.endpoint,
    OPENAI_API_KEY_FILE: filePath,
    AZURE_OPENAI_ENDPOINT: creds.endpoint,
    AZURE_OPENAI_API_KEY_FILE: filePath,
    CLAUDE_FOUNDRY_PROJECT: creds.projectId,
  };
  if (creds.apiVersion) {
    env.OPENAI_API_VERSION = creds.apiVersion;
    env.AZURE_OPENAI_API_VERSION = creds.apiVersion;
  }

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles: [{ path: filePath, content: secret }],
    requiresPostExecPersistence: false,
  };
}
