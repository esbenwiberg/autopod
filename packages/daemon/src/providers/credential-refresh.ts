import type { MaxCredentials } from '@autopod/shared';
import type { Logger } from 'pino';

const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Grace window: refresh if token expires within this many ms. */
const REFRESH_GRACE_MS = 5 * 60 * 1000;

/**
 * Refresh a MAX/PRO OAuth token if it's near expiry.
 * Returns the original credentials if the token is still fresh,
 * or updated credentials with new access/refresh tokens.
 */
export async function refreshOAuthToken(
  credentials: MaxCredentials,
  logger: Logger,
): Promise<MaxCredentials> {
  const expiresAt = new Date(credentials.expiresAt).getTime();
  const now = Date.now();

  if (expiresAt - now > REFRESH_GRACE_MS) {
    logger.debug('OAuth token still valid, skipping refresh');
    return credentials;
  }

  logger.info('OAuth access token near expiry, refreshing');

  const clientId = credentials.clientId ?? DEFAULT_CLIENT_ID;

  const response = await fetchWithRetry(
    CLAUDE_OAUTH_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: clientId,
      }),
    },
    logger,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '(no body)');
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `OAuth refresh token expired or revoked (HTTP ${response.status}). ` +
          `Re-authenticate the MAX/PRO account and update the profile credentials. Body: ${body}`,
      );
    }
    throw new Error(`OAuth token refresh failed (HTTP ${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const refreshed: MaxCredentials = {
    provider: 'max',
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    clientId: credentials.clientId,
    // Preserve fields the OAuth endpoint doesn't return — Claude CLI 2.1.80+
    // treats the user as logged-out if scopes/subscriptionType are missing.
    scopes: credentials.scopes,
    subscriptionType: credentials.subscriptionType,
    rateLimitTier: credentials.rateLimitTier,
  };

  logger.info({ expiresAt: refreshed.expiresAt }, 'OAuth token refreshed successfully');
  return refreshed;
}

/**
 * Fetch with a single retry on 5xx errors.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  logger: Logger,
  attempt = 1,
): Promise<Response> {
  const response = await fetch(url, init);

  if (response.status >= 500 && attempt < 2) {
    logger.warn(
      { status: response.status, attempt },
      'OAuth token endpoint returned 5xx, retrying',
    );
    await new Promise((r) => setTimeout(r, 1000));
    return fetchWithRetry(url, init, logger, attempt + 1);
  }

  return response;
}
