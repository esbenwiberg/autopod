import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type { MaxCredentials } from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ProfileStore } from '../profiles/index.js';
import { refreshOAuthToken } from './credential-refresh.js';
import type { MaxCredentialLineage } from './types.js';

/** Path where MAX credentials are written inside the container. */
const CREDENTIALS_PATH = `${CONTAINER_HOME_DIR}/.claude/.credentials.json`;

/**
 * In-process serialization keyed by credential-owner profile name. When
 * multiple pods on derived profiles share one owner (Option B credential
 * inheritance), their rotation persists must not interleave — the second
 * writer could otherwise blow away a fresher token from the first.
 */
const ownerLocks = new Map<string, Promise<void>>();

function withOwnerLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  const prev = ownerLocks.get(owner) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const next = run.then(
    () => undefined,
    () => undefined,
  );
  ownerLocks.set(owner, next);
  // Clean up once done so the map doesn't leak profile names forever.
  next.finally(() => {
    if (ownerLocks.get(owner) === next) ownerLocks.delete(owner);
  });
  return run;
}

function sameMaxCredentials(a: MaxCredentials, b: MaxCredentials): boolean {
  return (
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.expiresAt === b.expiresAt &&
    a.clientId === b.clientId &&
    JSON.stringify(a.scopes ?? null) === JSON.stringify(b.scopes ?? null) &&
    a.subscriptionType === b.subscriptionType &&
    a.rateLimitTier === b.rateLimitTier
  );
}

function mergeMaxMetadata(
  credentials: MaxCredentials,
  currentCreds: MaxCredentials | null | undefined,
): MaxCredentials {
  return {
    provider: 'max',
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    clientId: credentials.clientId ?? currentCreds?.clientId,
    scopes: credentials.scopes ?? currentCreds?.scopes,
    subscriptionType: credentials.subscriptionType ?? currentCreds?.subscriptionType,
    rateLimitTier: credentials.rateLimitTier ?? currentCreds?.rateLimitTier,
  };
}

async function persistMaxCredentialsUnderLock(
  profileStore: ProfileStore,
  ownerName: string,
  profileName: string,
  credentials: MaxCredentials,
  logger: Logger,
): Promise<MaxCredentials> {
  const ownerProfile = profileStore.getRaw(ownerName);
  const currentCreds =
    ownerProfile.providerCredentials?.provider === 'max' ? ownerProfile.providerCredentials : null;
  const updated = mergeMaxMetadata(credentials, currentCreds);

  if (currentCreds && sameMaxCredentials(updated, currentCreds)) {
    logger.debug(
      { profileName, ownerName },
      'Owner MAX credentials already match refreshed credentials — skipping persist',
    );
    return updated;
  }

  profileStore.update(ownerName, { providerCredentials: updated });
  logger.info(
    { profileName, ownerName, expiresAt: updated.expiresAt },
    'Persisted refreshed MAX credentials to credential owner',
  );
  return updated;
}

/**
 * Refresh MAX/PRO OAuth credentials under the credential-owner lock and persist
 * any token rotation before the pod starts. Anthropic rotates refresh tokens;
 * if two pods sharing one owner refresh concurrently, only the first old
 * refresh token is valid. Serializing here makes later pods re-read the fresh
 * owner credentials instead of burning the stale token.
 */
export async function refreshAndPersistMaxCredentials(
  profileStore: ProfileStore,
  profileName: string,
  fallbackCreds: MaxCredentials,
  logger: Logger,
): Promise<{ credentials: MaxCredentials; lineage: MaxCredentialLineage }> {
  const ownerName = profileStore.resolveCredentialOwner(profileName) ?? profileName;

  return withOwnerLock(ownerName, async () => {
    const ownerProfile = profileStore.getRaw(ownerName);
    const currentCreds =
      ownerProfile.providerCredentials?.provider === 'max'
        ? ownerProfile.providerCredentials
        : fallbackCreds;

    const refreshed = await refreshOAuthToken(currentCreds, logger);
    if (sameMaxCredentials(refreshed, currentCreds)) {
      return {
        credentials: currentCreds,
        lineage: { ownerName, issuedRefreshToken: currentCreds.refreshToken },
      };
    }

    const persisted = await persistMaxCredentialsUnderLock(
      profileStore,
      ownerName,
      profileName,
      refreshed,
      logger,
    );
    return {
      credentials: persisted,
      lineage: { ownerName, issuedRefreshToken: persisted.refreshToken },
    };
  });
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
  lineage?: MaxCredentialLineage,
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
    const currentCreds =
      ownerProfile.providerCredentials?.provider === 'max'
        ? ownerProfile.providerCredentials
        : null;

    if (currentCreds && currentCreds.refreshToken === oauth.refreshToken) {
      logger.debug(
        { profileName, ownerName },
        'Owner refresh token matches container — skipping persist',
      );
      return;
    }

    if (lineage) {
      if (!currentCreds) {
        logger.warn(
          { profileName, ownerName, lineageOwnerName: lineage.ownerName },
          'Skipping MAX credential persist because credential owner no longer has MAX credentials',
        );
        return;
      }

      if (
        ownerName !== lineage.ownerName ||
        currentCreds.refreshToken !== lineage.issuedRefreshToken
      ) {
        logger.warn(
          {
            profileName,
            ownerName,
            lineageOwnerName: lineage.ownerName,
            ownerTokenChanged: currentCreds.refreshToken !== lineage.issuedRefreshToken,
          },
          'Skipping stale MAX credential persist because credential owner advanced since container issue',
        );
        return;
      }
    }

    const updated: MaxCredentials = {
      provider: 'max',
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: new Date(oauth.expiresAt).toISOString(),
      clientId: currentCreds?.clientId,
      scopes: currentCreds?.scopes,
      subscriptionType: currentCreds?.subscriptionType,
      rateLimitTier: currentCreds?.rateLimitTier,
    };

    await persistMaxCredentialsUnderLock(profileStore, ownerName, profileName, updated, logger);
  });
}
