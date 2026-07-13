import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type {
  FoundryCredentials,
  MaxCredentials,
  MaxRefreshCredentials,
  MaxSetupTokenCredentials,
  PiOAuthCredentials,
  Profile,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { RUNTIME_TELEMETRY_OPT_OUT_ENV, withRuntimeTelemetryOptOutEnv } from '../runtime-env.js';
import { type ProviderAuthResolution, resolveProviderAuth } from './auth-resolution.js';
import { getAzureToken } from './azure-token.js';
import { refreshAndPersistMaxCredentials } from './credential-persistence.js';
import { refreshOAuthToken } from './credential-refresh.js';
import type { ProviderEnvResult } from './types.js';

type ContainerFile = ProviderEnvResult['containerFiles'][number];

const CONTAINER_WORK_DIR = '/workspace';

export interface BuildProviderEnvOptions {
  profileStore?: ProfileStore;
  providerAccountStore?: ProviderAccountStore;
}

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
      env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', ...RUNTIME_TELEMETRY_OPT_OUT_ENV },
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
  options: BuildProviderEnvOptions = {},
): Promise<ProviderEnvResult> {
  const provider = profile.modelProvider;
  const auth = resolveProviderAuth(profile, options);
  if (auth.owner?.type === 'provider-account') {
    options.providerAccountStore?.touchLastUsed(auth.owner.id);
  }

  switch (provider) {
    case 'anthropic':
      return buildAnthropicEnv();

    case 'max':
      return buildMaxEnv(profile, auth, logger, options);

    case 'openai':
      return buildOpenAiEnv(auth);

    case 'foundry':
      return buildFoundryEnv(profile, auth, logger);

    case 'copilot':
      return buildCopilotEnv(profile, auth);

    case 'openrouter':
      return buildOpenRouterEnv(profile, auth);

    case 'pi':
      return buildPiEnv(profile, auth);

    default:
      // Exhaustiveness check
      throw new Error(`Unknown model provider: ${provider as string}`);
  }
}

const SECRET_DIR = '/run/autopod';
const CODEX_HOME_DIR = `${CONTAINER_HOME_DIR}/.codex`;
const PI_AGENT_DIR = `${CONTAINER_HOME_DIR}/.pi/agent`;
const PI_AUTH_PATH = `${PI_AGENT_DIR}/auth.json`;

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

/**
 * Anthropic API key provider — uses daemon env var.
 * The key is written to a 0400 secret file inside the container; the exec env
 * carries only the _FILE pointer so the raw key never appears in env dumps.
 */
function buildAnthropicEnv(): ProviderEnvResult {
  const env = withRuntimeTelemetryOptOutEnv();
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
 * OpenAI API key provider — used by the Codex runtime.
 * The key is written to a secret file; exec env only receives the file pointer.
 */
function buildOpenAiEnv(auth: ProviderAuthResolution): ProviderEnvResult {
  const creds = auth.credentials;
  if (creds?.provider === 'openai' && creds.authJson) {
    return {
      env: withRuntimeTelemetryOptOutEnv({ CODEX_HOME: CODEX_HOME_DIR }),
      containerFiles: [
        ...buildClaudeConfigFiles(),
        { path: `${CODEX_HOME_DIR}/auth.json`, content: creds.authJson },
      ],
      secretFiles: [],
      requiresPostExecPersistence: true,
      requiresOpenAiAuthJsonPersistence: true,
      credentialOwner: auth.owner ?? undefined,
    };
  }

  const env = withRuntimeTelemetryOptOutEnv({ CODEX_HOME: CODEX_HOME_DIR });
  const secretFiles: ProviderEnvResult['secretFiles'] = [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    const filePath = `${SECRET_DIR}/openai-api-key`;
    secretFiles.push({ path: filePath, content: apiKey });
    env.OPENAI_API_KEY_FILE = filePath;
  }

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles,
    requiresPostExecPersistence: Boolean(auth.owner),
    requiresOpenAiAuthJsonPersistence: Boolean(auth.owner),
    credentialOwner: auth.owner ?? undefined,
  };
}

/**
 * MAX/PRO OAuth provider.
 *
 * Supports both current setup-token credentials (injected as
 * `CLAUDE_CODE_OAUTH_TOKEN`) and legacy `.claude/.credentials.json` refresh
 * credentials. The legacy path refreshes access tokens and persists rotations;
 * the setup-token path has no container credential file to read back.
 */
async function buildMaxEnv(
  profile: Profile,
  auth: ProviderAuthResolution,
  logger: Logger,
  options: BuildProviderEnvOptions,
): Promise<ProviderEnvResult> {
  const creds = auth.credentials;

  if (!creds || creds.provider !== 'max') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=max but missing or mismatched providerCredentials`,
    );
  }

  if (isMaxSetupTokenCredentials(creds)) {
    const filePath = `${SECRET_DIR}/claude-code-oauth-token`;
    return {
      env: withRuntimeTelemetryOptOutEnv({ CLAUDE_CODE_OAUTH_TOKEN_FILE: filePath }),
      containerFiles: buildClaudeConfigFiles(),
      secretFiles: [{ path: filePath, content: creds.oauthToken }],
      requiresPostExecPersistence: false,
      credentialOwner: auth.owner ?? undefined,
    };
  }

  if (!isMaxRefreshCredentials(creds)) {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=max but invalid providerCredentials`,
    );
  }

  // Pre-flight token refresh. When the profile store is available, serialize
  // by credential owner and persist rotations immediately so concurrent pods
  // do not reuse a stale refresh token.
  const issued = options.profileStore
    ? await refreshAndPersistMaxCredentials(options.profileStore, profile.name, creds, logger, {
        providerAccountStore: options.providerAccountStore,
        owner: auth.owner ?? undefined,
      })
    : await (async () => {
        const credentials = await refreshOAuthToken(creds, logger);
        return {
          credentials,
          lineage: {
            owner: auth.owner ?? { type: 'profile', name: profile.name },
            issuedRefreshToken: credentials.refreshToken,
          },
        };
      })();
  const refreshed = issued.credentials;

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
    env: withRuntimeTelemetryOptOutEnv(),
    containerFiles: [{ path: credPath, content: credentialsFile }, ...buildClaudeConfigFiles()],
    secretFiles: [],
    requiresPostExecPersistence: true,
    credentialOwner: auth.owner ?? undefined,
    maxCredentialLineage: issued.lineage,
  };
}

/**
 * GitHub Copilot CLI provider — token written to a 0400 secret file; env carries
 * only COPILOT_GITHUB_TOKEN_FILE so the raw token stays out of env dumps.
 */
function buildCopilotEnv(profile: Profile, auth: ProviderAuthResolution): ProviderEnvResult {
  const creds = auth.credentials;

  if (!creds || creds.provider !== 'copilot') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=copilot but missing or mismatched providerCredentials`,
    );
  }

  const filePath = `${SECRET_DIR}/copilot-token`;
  const env = withRuntimeTelemetryOptOutEnv({ COPILOT_GITHUB_TOKEN_FILE: filePath });
  if (creds.model) env.COPILOT_MODEL = creds.model;

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles: [{ path: filePath, content: creds.token }],
    requiresPostExecPersistence: false,
    credentialOwner: auth.owner ?? undefined,
  };
}

function isPiOAuthCredentials(creds: unknown): creds is PiOAuthCredentials {
  return (
    !!creds &&
    typeof creds === 'object' &&
    !Array.isArray(creds) &&
    (creds as { provider?: unknown }).provider === 'pi' &&
    typeof (creds as { providerId?: unknown }).providerId === 'string' &&
    !!(creds as { credential?: unknown }).credential &&
    typeof (creds as { credential?: unknown }).credential === 'object' &&
    !Array.isArray((creds as { credential?: unknown }).credential)
  );
}

function buildPiEnv(profile: Profile, auth: ProviderAuthResolution): ProviderEnvResult {
  const creds = auth.credentials;

  if (!isPiOAuthCredentials(creds)) {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=pi but missing or mismatched providerCredentials`,
    );
  }

  const authJson = JSON.stringify({ [creds.providerId]: creds.credential }, null, 2);

  return {
    env: withRuntimeTelemetryOptOutEnv({
      PI_CODING_AGENT_DIR: PI_AGENT_DIR,
    }),
    containerFiles: [
      ...buildClaudeConfigFiles(),
      {
        path: PI_AUTH_PATH,
        content: authJson,
      },
    ],
    secretFiles: [],
    requiresPostExecPersistence: true,
    requiresPiAuthJsonPersistence: true,
    credentialOwner: auth.owner ?? undefined,
  };
}

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter aggregator provider — routes the Codex runtime through OpenRouter's
 * OpenAI-compatible endpoint by setting OPENAI_BASE_URL + injecting the API key
 * via secret file. The model string on the pod (e.g. "deepseek/deepseek-r1") is
 * passed straight through to OpenRouter as-is.
 *
 * API key resolution order:
 *   1. Per-profile providerCredentials.apiKey (set via desktop or CLI)
 *   2. Daemon env var OPENROUTER_API_KEY (convenience for dev / single-key setups)
 *
 * Only use models that have passed the spike telemetry contract.
 */
function buildOpenRouterEnv(profile: Profile, auth: ProviderAuthResolution): ProviderEnvResult {
  const creds = auth.credentials;
  const isOpenRouterCreds = creds?.provider === 'openrouter';
  const baseUrl = isOpenRouterCreds
    ? (creds.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL)
    : OPENROUTER_DEFAULT_BASE_URL;
  // Key priority: per-profile openrouterApiKey > per-profile providerCredentials.apiKey > daemon env
  const apiKey =
    profile.openrouterApiKey ??
    (isOpenRouterCreds ? creds.apiKey : undefined) ??
    process.env.OPENROUTER_API_KEY;

  const filePath = `${SECRET_DIR}/openrouter-api-key`;
  const env = withRuntimeTelemetryOptOutEnv({
    CODEX_HOME: CODEX_HOME_DIR,
    OPENAI_BASE_URL: baseUrl,
  });
  const secretFiles: ProviderEnvResult['secretFiles'] = [];

  if (apiKey) {
    secretFiles.push({ path: filePath, content: apiKey });
    env.OPENAI_API_KEY_FILE = filePath;
  }

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles,
    requiresPostExecPersistence: false,
    credentialOwner: auth.owner ?? undefined,
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
async function buildFoundryEnv(
  profile: Profile,
  auth: ProviderAuthResolution,
  logger: Logger,
): Promise<ProviderEnvResult> {
  const creds = auth.credentials;

  if (!creds || creds.provider !== 'foundry') {
    throw new Error(
      `Profile "${profile.name}" has modelProvider=foundry but missing or mismatched providerCredentials`,
    );
  }

  const surface = creds.apiSurface ?? 'anthropic';
  const secretValue = await resolveFoundrySecret(creds, logger);

  return surface === 'openai'
    ? buildFoundryOpenAiEnv(creds, secretValue, auth)
    : buildFoundryAnthropicEnv(creds, secretValue, auth);
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

function buildFoundryAnthropicEnv(
  creds: FoundryCredentials,
  secret: string,
  auth: ProviderAuthResolution,
): ProviderEnvResult {
  const filePath = `${SECRET_DIR}/foundry-api-key`;
  const env = withRuntimeTelemetryOptOutEnv({
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_BASE_URL: creds.endpoint,
    CLAUDE_FOUNDRY_PROJECT: creds.projectId,
    ANTHROPIC_API_KEY_FILE: filePath,
  });

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles: [{ path: filePath, content: secret }],
    requiresPostExecPersistence: false,
    credentialOwner: auth.owner ?? undefined,
  };
}

function buildFoundryOpenAiEnv(
  creds: FoundryCredentials,
  secret: string,
  auth: ProviderAuthResolution,
): ProviderEnvResult {
  const filePath = `${SECRET_DIR}/foundry-openai-key`;
  const env = withRuntimeTelemetryOptOutEnv({
    CODEX_HOME: CODEX_HOME_DIR,
    OPENAI_BASE_URL: creds.endpoint,
    OPENAI_API_KEY_FILE: filePath,
    AZURE_OPENAI_ENDPOINT: creds.endpoint,
    AZURE_OPENAI_API_KEY_FILE: filePath,
    CLAUDE_FOUNDRY_PROJECT: creds.projectId,
  });
  if (creds.apiVersion) {
    env.OPENAI_API_VERSION = creds.apiVersion;
    env.AZURE_OPENAI_API_VERSION = creds.apiVersion;
  }

  return {
    env,
    containerFiles: buildClaudeConfigFiles(),
    secretFiles: [{ path: filePath, content: secret }],
    requiresPostExecPersistence: false,
    credentialOwner: auth.owner ?? undefined,
  };
}
