import type { Logger } from 'pino';

/**
 * Shared Azure access token acquirer.
 *
 * Mirrors the az-CLI → managed-identity → cached pattern used by Azure action
 * handlers. Lifted here so other code paths (Foundry credential injection,
 * future Azure-backed features) can reuse the same auth chain instead of growing
 * more copies.
 *
 * Local/dev VM: works because an explicit `az login` session is preferred before
 * hosted managed identity. No user re-auth, no Entra app registration needed.
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

export interface AzureTokenOptions {
  /** Explicit Entra tenant for guest/no-subscription resource access. */
  tenantId?: string;
}

/**
 * Acquire an Azure access token for the given scope.
 *
 * Resolution order:
 *  1. Cached token (if not within the refresh buffer of expiry)
 *  2. `az account get-access-token` — prefer the daemon host's explicit CLI
 *     login, including Azure VM SSH sessions
 *  3. `DefaultAzureCredential` — managed identity in Azure-hosted environments
 *     or environment-variable service principal fallback
 *
 * When `tenantId` is pinned, a fallback token whose `tid` claim names another
 * tenant is rejected instead of returned. Managed identity silently ignores the
 * requested tenant, so without this check a guest-tenant caller (e.g. ADO in a
 * foreign tenant) gets a home-tenant token that the resource rejects with 401,
 * and the cache then serves that dead token for the managed identity's ~24h
 * lifetime.
 *
 * Throws with a guidance message if all paths fail.
 */
export async function getAzureToken(
  scope: string,
  logger: Logger,
  options: AzureTokenOptions = {},
): Promise<AzureTokenResult> {
  const tenantId = options.tenantId?.trim() || undefined;
  const cacheKey = tokenCacheKey(scope, tenantId);
  const log = logger.child({ component: 'azure-token', scope, tenantId });

  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAtMs) {
    return { token: cached.token, expiresAtMs: cached.expiresAtMs };
  }

  // az CLI takes a resource (not a /.default scope), so strip the suffix.
  const resource = scope.replace(/\/\.default$/, '');
  const az = await getTokenFromAzCli(resource, log, tenantId);
  if (az.ok) {
    cache.set(cacheKey, az.token);
    return { token: az.token.token, expiresAtMs: az.token.expiresAtMs };
  }

  let identityErr: string | undefined;
  try {
    const { DefaultAzureCredential } = await import('@azure/identity');
    const credential = new DefaultAzureCredential();
    const tokenResponse = tenantId
      ? await credential.getToken(scope, { tenantId })
      : await credential.getToken(scope);
    if (tenantId) {
      const issuedTenant = tokenTenantId(tokenResponse.token);
      if (issuedTenant?.toLowerCase() !== tenantId.toLowerCase()) {
        throw new Error(
          `DefaultAzureCredential returned a token for tenant '${issuedTenant ?? 'unknown'}' instead of '${tenantId}' (managed identity cannot cross tenants)`,
        );
      }
    }
    const expiresAtMs =
      (tokenResponse.expiresOnTimestamp ?? Date.now() + FALLBACK_TTL_MS) - TOKEN_REFRESH_BUFFER_MS;
    const entry: CachedToken = { token: tokenResponse.token, expiresAtMs };
    cache.set(cacheKey, entry);
    log.debug('Token acquired via DefaultAzureCredential');
    return { token: entry.token, expiresAtMs };
  } catch (err) {
    identityErr = err instanceof Error ? err.message : String(err);
    log.debug({ err: identityErr }, 'DefaultAzureCredential failed after az CLI was unavailable');
  }

  cache.delete(cacheKey);
  throw new Error(
    `Azure auth failed for scope '${scope}' — ensure Managed Identity is available, set AZURE_CLIENT_ID/AZURE_CLIENT_SECRET/AZURE_TENANT_ID, or run 'az login'. az CLI: ${az.reason}. Last error: ${identityErr ?? 'unknown'}`,
  );
}

type AzCliResult = { ok: true; token: CachedToken } | { ok: false; reason: string };

async function getTokenFromAzCli(
  resource: string,
  log: Logger,
  tenantId?: string,
): Promise<AzCliResult> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const args = ['account', 'get-access-token', '--resource', resource];
    if (tenantId) args.push('--tenant', tenantId);
    args.push('--output', 'json');
    const { stdout } = await execFileAsync('az', args, { timeout: AZ_CLI_TIMEOUT_MS });

    const parsed = JSON.parse(stdout) as { accessToken?: string; expiresOn?: string };
    if (!parsed.accessToken) {
      log.warn('az CLI returned no accessToken — falling back to DefaultAzureCredential');
      return { ok: false, reason: 'no accessToken in output' };
    }

    const expiresAtMs = parsed.expiresOn
      ? new Date(parsed.expiresOn).getTime() - TOKEN_REFRESH_BUFFER_MS
      : Date.now() + FALLBACK_TTL_MS - TOKEN_REFRESH_BUFFER_MS;

    log.debug('Token acquired via az CLI');
    return { ok: true, token: { token: parsed.accessToken, expiresAtMs } };
  } catch (err) {
    const reason = azCliFailureReason(err);
    // A host without az is a supported (managed-identity-only) setup, not a fault.
    if ((err as { code?: unknown }).code === 'ENOENT')
      log.debug({ reason }, 'az CLI not installed');
    else log.warn({ reason }, 'az CLI token acquisition failed — falling back');
    return { ok: false, reason };
  }
}

/** az's stderr carries the actionable cause (AADSTS code, expired login, lock contention). */
function azCliFailureReason(err: unknown): string {
  const record = err as { stderr?: unknown; killed?: unknown; code?: unknown };
  if (record.killed) return `timed out after ${AZ_CLI_TIMEOUT_MS}ms`;
  if (record.code === 'ENOENT') return 'az not installed';
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  const detail = stderr || (err instanceof Error ? err.message : String(err));
  return detail.replace(/\s+/g, ' ').slice(0, 500);
}

/**
 * Read the `tid` claim without verifying the signature — this is a
 * misconfiguration guard, not an authentication decision. Returns undefined for
 * opaque/encrypted tokens.
 */
function tokenTenantId(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      tid?: unknown;
    };
    return typeof claims.tid === 'string' ? claims.tid : undefined;
  } catch {
    return undefined;
  }
}

function tokenCacheKey(scope: string, tenantId?: string): string {
  return tenantId ? `${tenantId}:${scope}` : scope;
}

/**
 * Drop a cached token after the resource rejected it (401), so the next call
 * re-acquires instead of replaying the rejected token until it expires.
 */
export function invalidateAzureToken(scope: string, options: AzureTokenOptions = {}): void {
  cache.delete(tokenCacheKey(scope, options.tenantId?.trim() || undefined));
}

/** Test hook — clears the in-process token cache. */
export function clearAzureTokenCache(): void {
  cache.clear();
}
