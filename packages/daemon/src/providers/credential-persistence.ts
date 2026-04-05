import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type { MaxCredentials } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ProfileStore } from '../profiles/index.js';

/** Path where MAX credentials are written inside the container. */
const CREDENTIALS_PATH = `${CONTAINER_HOME_DIR}/.claude/.credentials.json`;

/**
 * Read back OAuth credentials from the container after agent execution.
 *
 * Claude Code rotates refresh tokens during use. If we don't persist the
 * updated tokens, the next session will fail to authenticate.
 *
 * Uses optimistic locking: only overwrites if the new token has a later
 * expiry than what's currently stored (guards against concurrent session stomps).
 */
export async function persistRefreshedCredentials(
  containerId: string,
  containerManager: ContainerManager,
  profileStore: ProfileStore,
  profileName: string,
  logger: Logger,
): Promise<void> {
  // Read the credentials file from the container
  let rawContent: string;
  try {
    rawContent = await containerManager.readFile(containerId, CREDENTIALS_PATH);
  } catch (err) {
    logger.warn(
      { err, containerId, profileName },
      'Could not read credentials file from container — token rotation may be lost',
    );
    return;
  }

  // Parse the Claude credentials format
  let parsed: {
    claudeAiOauth?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      scopes?: string[];
      subscriptionType?: string;
      rateLimitTier?: string;
    };
  };
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    logger.warn({ err, profileName }, 'Failed to parse credentials file from container');
    return;
  }

  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.expiresAt) {
    logger.warn({ profileName }, 'Credentials file missing required OAuth fields');
    return;
  }

  // Only update if the container has different credentials than what's stored.
  // We compare refresh tokens (not expiry) because rotating refresh tokens
  // invalidate the previous one — using a stale refresh token causes invalid_grant.
  // Expiry-based comparison was wrong: a rotated token can have a shorter or equal
  // expiry but still be the only valid refresh token.
  const currentProfile = profileStore.getRaw(profileName);
  const currentCreds = currentProfile.providerCredentials;

  if (currentCreds?.provider === 'max' && currentCreds.refreshToken === oauth.refreshToken) {
    logger.debug(
      { profileName },
      'Container refresh token matches stored — skipping persist',
    );
    return;
  }

  // Build updated credentials — preserve all fields from the file
  const updated: MaxCredentials = {
    provider: 'max',
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: new Date(oauth.expiresAt).toISOString(),
    // Preserve fields from stored credentials that aren't in the rotated token response
    clientId: currentCreds?.provider === 'max' ? currentCreds.clientId : undefined,
    scopes: currentCreds?.provider === 'max' ? currentCreds.scopes : undefined,
    subscriptionType: currentCreds?.provider === 'max' ? currentCreds.subscriptionType : undefined,
    rateLimitTier: currentCreds?.provider === 'max' ? currentCreds.rateLimitTier : undefined,
  };

  profileStore.update(profileName, { providerCredentials: updated });
  logger.info(
    { profileName, expiresAt: updated.expiresAt },
    'Persisted rotated OAuth credentials from container',
  );
}
