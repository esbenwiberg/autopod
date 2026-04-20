import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type { MaxCredentials } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ProfileStore } from '../profiles/index.js';

/** Path where MAX credentials are written inside the container. */
const CREDENTIALS_PATH = `${CONTAINER_HOME_DIR}/.claude/.credentials.json`;

/**
 * In-process serialization keyed by credential-owner profile name. When
 * multiple pods on derived profiles share one owner (Option B credential
 * inheritance), their rotation persists must not interleave — the second
 * writer could otherwise blow away a fresher token from the first.
 */
const ownerLocks = new Map<string, Promise<void>>();

function withOwnerLock(owner: string, fn: () => Promise<void>): Promise<void> {
  const prev = ownerLocks.get(owner) ?? Promise.resolve();
  const next = prev.then(fn, fn).catch(() => {
    /* swallow — per-call errors are already logged by fn */
  });
  ownerLocks.set(owner, next);
  // Clean up once done so the map doesn't leak profile names forever.
  next.finally(() => {
    if (ownerLocks.get(owner) === next) ownerLocks.delete(owner);
  });
  return next;
}

/**
 * Read back OAuth credentials from the container after agent execution.
 *
 * Claude Code rotates refresh tokens during use. If we don't persist the
 * updated tokens, the next pod will fail to authenticate.
 *
 * The rotated credentials are written to whichever profile in the extends
 * chain actually owns the auth state (not necessarily the pod's profile).
 * This matches the credential-inheritance design where a base profile can
 * hold one MAX login used by all its descendants.
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

  // Resolve which profile actually owns these credentials. For derived
  // profiles that inherit from a parent, rotations go to the parent's row
  // so all sibling profiles stay in sync.
  const ownerName = profileStore.resolveCredentialOwner(profileName) ?? profileName;

  await withOwnerLock(ownerName, async () => {
    // Re-read under the lock — another concurrent run may have persisted.
    const ownerProfile = profileStore.getRaw(ownerName);
    const currentCreds = ownerProfile.providerCredentials;

    if (currentCreds?.provider === 'max' && currentCreds.refreshToken === oauth.refreshToken) {
      logger.debug(
        { profileName, ownerName },
        'Owner refresh token matches container — skipping persist',
      );
      return;
    }

    const updated: MaxCredentials = {
      provider: 'max',
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: new Date(oauth.expiresAt).toISOString(),
      clientId: currentCreds?.provider === 'max' ? currentCreds.clientId : undefined,
      scopes: currentCreds?.provider === 'max' ? currentCreds.scopes : undefined,
      subscriptionType:
        currentCreds?.provider === 'max' ? currentCreds.subscriptionType : undefined,
      rateLimitTier: currentCreds?.provider === 'max' ? currentCreds.rateLimitTier : undefined,
    };

    profileStore.update(ownerName, { providerCredentials: updated });
    logger.info(
      { profileName, ownerName, expiresAt: updated.expiresAt },
      'Persisted rotated OAuth credentials to credential owner',
    );
  });
}
