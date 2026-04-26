import type { Logger } from 'pino';

/**
 * Shared Azure access token acquirer.
 *
 * Mirrors the managed-identity → az-CLI → cached pattern that the action handlers
 * (`azure-pim-handler`, `azure-logs-handler`) open-coded for ARM/Graph. Lifted
 * here so other code paths (Foundry credential injection, future Azure-backed
 * features) can reuse the same auth chain instead of growing more copies.
 *
 * Local dev: works because `DefaultAzureCredential` falls back to the user's
 * `az login` session. No user re-auth, no Entra app registration needed.
 *
 * Tokens are cached per-scope with a 5-minute expiry buffer so callers don't
 * have to think about lifetime — just call `getAzureToken(scope, logger)`.
 */

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const AZ_CLI_TIMEOUT_MS = 15_000;
const FALLBACK_TTL_MS = 3600_000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedToken>();

export interface AzureTokenResult {
  token: string;
  /** Wall-clock ms when the token expires (already accounting for the refresh buffer). */
  expiresAtMs: number;
}

/**
 * Acquire an Azure access token for the given scope.
 *
 * Resolution order:
 *  1. Cached token (if not within the refresh buffer of expiry)
 *  2. `DefaultAzureCredential` — managed identity in Azure-hosted environments,
 *     environment-variable service principal, or `az login` session locally
 *  3. `az account get-access-token` shell fallback (in case @azure/identity's
 *     `AzureCliCredential` chain misses the active session)
 *
 * Throws with a guidance message if all paths fail.
 */
export async function getAzureToken(scope: string, logger: Logger): Promise<AzureTokenResult> {
  const log = logger.child({ component: 'azure-token', scope });

  const cached = cache.get(scope);
  if (cached && Date.now() < cached.expiresAtMs) {
    return { token: cached.token, expiresAtMs: cached.expiresAtMs };
  }

  let identityErr: string | undefined;
  try {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken(scope);
    const expiresAtMs =
      (tokenResponse.expiresOnTimestamp ?? Date.now() + FALLBACK_TTL_MS) - TOKEN_REFRESH_BUFFER_MS;
    const entry: CachedToken = { token: tokenResponse.token, expiresAtMs };
    cache.set(scope, entry);
    log.debug('Token acquired via DefaultAzureCredential');
    return { token: entry.token, expiresAtMs };
  } catch (err) {
    identityErr = err instanceof Error ? err.message : String(err);
    log.debug({ err: identityErr }, 'DefaultAzureCredential failed, trying az CLI fallback');
  }

  // az CLI takes a resource (not a /.default scope), so strip the suffix.
  const resource = scope.replace(/\/\.default$/, '');
  const azResult = await getTokenFromAzCli(resource, log);
  if (azResult) {
    cache.set(scope, azResult);
    return { token: azResult.token, expiresAtMs: azResult.expiresAtMs };
  }

  cache.delete(scope);
  throw new Error(
    `Azure auth failed for scope '${scope}' — ensure Managed Identity is available, set AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID, or run 'az login'. Last error: ${identityErr ?? 'unknown'}`,
  );
}

async function getTokenFromAzCli(resource: string, log: Logger): Promise<CachedToken | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(
      'az',
      ['account', 'get-access-token', '--resource', resource, '--output', 'json'],
      { timeout: AZ_CLI_TIMEOUT_MS },
    );

    const parsed = JSON.parse(stdout) as { accessToken?: string; expiresOn?: string };
    if (!parsed.accessToken) return null;

    const expiresAtMs = parsed.expiresOn
      ? new Date(parsed.expiresOn).getTime() - TOKEN_REFRESH_BUFFER_MS
      : Date.now() + FALLBACK_TTL_MS - TOKEN_REFRESH_BUFFER_MS;

    log.debug('Token acquired via az CLI');
    return { token: parsed.accessToken, expiresAtMs };
  } catch {
    return null;
  }
}

/** Test hook — clears the in-process token cache. */
export function clearAzureTokenCache(): void {
  cache.clear();
}
