import { CONTAINER_HOME_DIR } from '@autopod/shared';
import type {
  MaxCredentials,
  MaxRefreshCredentials,
  OpenAiCredentials,
  PiOAuthCredentials,
  PiOAuthProviderId,
  ProviderCredentials,
} from '@autopod/shared';
import type { Logger } from 'pino';
import type { ContainerManager } from '../interfaces/container-manager.js';
import type { ProfileStore } from '../profiles/index.js';
import type { ProviderAccountStore } from '../provider-accounts/index.js';
import { type CredentialOwner, credentialOwnerKey } from './auth-resolution.js';
import { refreshOAuthToken } from './credential-refresh.js';
import type { MaxCredentialLineage } from './types.js';

/** Path where MAX credentials are written inside the container. */
const CREDENTIALS_PATH = `${CONTAINER_HOME_DIR}/.claude/.credentials.json`;
/** Path where Codex stores ChatGPT/OpenAI auth inside the container. */
const CODEX_AUTH_PATH = `${CONTAINER_HOME_DIR}/.codex/auth.json`;
/** Path where Pi stores provider OAuth entries inside the container. */
const PI_AUTH_PATH = `${CONTAINER_HOME_DIR}/.pi/agent/auth.json`;

/**
 * In-process serialization keyed by credential owner. When multiple pods share
 * one account/profile owner, their persists must not interleave — the second
 * writer could otherwise blow away a fresher token from the first.
 */
const ownerLocks = new Map<string, Promise<void>>();

function withOwnerLock<T>(ownerKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = ownerLocks.get(ownerKey) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const next = run.then(
    () => undefined,
    () => undefined,
  );
  ownerLocks.set(ownerKey, next);
  // Clean up once done so the map doesn't leak owner ids forever.
  next.finally(() => {
    if (ownerLocks.get(ownerKey) === next) ownerLocks.delete(ownerKey);
  });
  return run;
}

interface CredentialPersistenceOptions {
  providerAccountStore?: ProviderAccountStore;
  owner?: CredentialOwner;
}

function isMaxRefreshCredentials(
  credentials: MaxCredentials | null | undefined,
): credentials is MaxRefreshCredentials {
  return (
    credentials?.provider === 'max' &&
    'accessToken' in credentials &&
    'refreshToken' in credentials &&
    'expiresAt' in credentials
  );
}

function sameMaxCredentials(a: MaxRefreshCredentials, b: MaxRefreshCredentials): boolean {
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
  credentials: MaxRefreshCredentials,
  currentCreds: MaxCredentials | null | undefined,
): MaxRefreshCredentials {
  const currentRefreshCreds = isMaxRefreshCredentials(currentCreds) ? currentCreds : null;
  return {
    provider: 'max',
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    clientId: credentials.clientId ?? currentRefreshCreds?.clientId,
    scopes: credentials.scopes ?? currentRefreshCreds?.scopes,
    subscriptionType: credentials.subscriptionType ?? currentRefreshCreds?.subscriptionType,
    rateLimitTier: credentials.rateLimitTier ?? currentRefreshCreds?.rateLimitTier,
  };
}

function ownerLogFields(owner: CredentialOwner): Record<string, string> {
  return owner.type === 'provider-account'
    ? { credentialOwnerType: owner.type, credentialOwnerId: owner.id }
    : { credentialOwnerType: owner.type, credentialOwnerName: owner.name };
}

function resolveMaxOwner(
  profileStore: ProfileStore,
  profileName: string,
  options: CredentialPersistenceOptions,
): CredentialOwner {
  if (options.owner) return options.owner;
  const providerAccountId = profileStore.resolveProviderAccountId?.(profileName);
  if (providerAccountId) return { type: 'provider-account', id: providerAccountId };
  return { type: 'profile', name: profileStore.resolveCredentialOwner(profileName) ?? profileName };
}

function resolveExistingAuthOwner(
  profileStore: ProfileStore,
  profileName: string,
  options: CredentialPersistenceOptions,
): CredentialOwner | null {
  if (options.owner) return options.owner;
  const providerAccountId = profileStore.resolveProviderAccountId?.(profileName);
  if (providerAccountId) return { type: 'provider-account', id: providerAccountId };
  const credentialOwner = profileStore.resolveCredentialOwner(profileName);
  return credentialOwner ? { type: 'profile', name: credentialOwner } : null;
}

function getOwnerCredentials(
  profileStore: ProfileStore,
  providerAccountStore: ProviderAccountStore | undefined,
  owner: CredentialOwner,
): ProviderCredentials | null {
  if (owner.type === 'profile') {
    return profileStore.getRaw(owner.name).providerCredentials;
  }
  if (!providerAccountStore) {
    throw new Error('Provider account credential owner requires ProviderAccountStore');
  }
  return providerAccountStore.get(owner.id).credentials;
}

function updateOwnerCredentials(
  profileStore: ProfileStore,
  providerAccountStore: ProviderAccountStore | undefined,
  owner: CredentialOwner,
  credentials: ProviderCredentials | null,
): void {
  if (owner.type === 'profile') {
    profileStore.update(owner.name, { providerCredentials: credentials });
    return;
  }
  if (!providerAccountStore) {
    throw new Error('Provider account credential owner requires ProviderAccountStore');
  }
  providerAccountStore.updateCredentials(owner.id, credentials);
}

async function persistMaxCredentialsUnderLock(
  profileStore: ProfileStore,
  providerAccountStore: ProviderAccountStore | undefined,
  owner: CredentialOwner,
  profileName: string,
  credentials: MaxRefreshCredentials,
  logger: Logger,
): Promise<MaxRefreshCredentials> {
  const rawCurrentCreds = getOwnerCredentials(profileStore, providerAccountStore, owner);
  const currentCreds = rawCurrentCreds?.provider === 'max' ? rawCurrentCreds : null;
  const updated = mergeMaxMetadata(credentials, currentCreds);

  if (isMaxRefreshCredentials(currentCreds) && sameMaxCredentials(updated, currentCreds)) {
    logger.debug(
      { profileName, ...ownerLogFields(owner) },
      'Owner MAX credentials already match refreshed credentials — skipping persist',
    );
    return updated;
  }

  updateOwnerCredentials(profileStore, providerAccountStore, owner, updated);
  logger.info(
    { profileName, ...ownerLogFields(owner), expiresAt: updated.expiresAt },
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
  fallbackCreds: MaxRefreshCredentials,
  logger: Logger,
  options: CredentialPersistenceOptions = {},
): Promise<{ credentials: MaxRefreshCredentials; lineage: MaxCredentialLineage }> {
  const owner = resolveMaxOwner(profileStore, profileName, options);
  const ownerKey = credentialOwnerKey(owner);

  return withOwnerLock(ownerKey, async () => {
    const rawCurrentCreds = getOwnerCredentials(profileStore, options.providerAccountStore, owner);
    const currentCreds = rawCurrentCreds?.provider === 'max' ? rawCurrentCreds : fallbackCreds;
    if (!isMaxRefreshCredentials(currentCreds)) {
      throw new Error(
        `Profile "${profileName}" uses MAX setup-token auth; refresh-token rotation is not available`,
      );
    }

    const refreshed = await refreshOAuthToken(currentCreds, logger);
    if (sameMaxCredentials(refreshed, currentCreds)) {
      return {
        credentials: currentCreds,
        lineage: { owner, issuedRefreshToken: currentCreds.refreshToken },
      };
    }

    const persisted = await persistMaxCredentialsUnderLock(
      profileStore,
      options.providerAccountStore,
      owner,
      profileName,
      refreshed,
      logger,
    );
    return {
      credentials: persisted,
      lineage: { owner, issuedRefreshToken: persisted.refreshToken },
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
  options: CredentialPersistenceOptions = {},
): Promise<void> {
  const owner = resolveMaxOwner(profileStore, profileName, {
    ...options,
    owner: options.owner ?? lineage?.owner,
  });
  const ownerKey = credentialOwnerKey(owner);
  const rawInitialOwnerCreds = getOwnerCredentials(
    profileStore,
    options.providerAccountStore,
    owner,
  );
  const initialOwnerCreds = rawInitialOwnerCreds?.provider === 'max' ? rawInitialOwnerCreds : null;
  if (initialOwnerCreds && !isMaxRefreshCredentials(initialOwnerCreds)) {
    logger.debug(
      { profileName, ...ownerLogFields(owner) },
      'Skipping MAX credential persist because credential owner uses setup-token auth',
    );
    return;
  }

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
  await withOwnerLock(ownerKey, async () => {
    // Re-read under the lock — another concurrent run may have persisted.
    const rawCurrentCreds = getOwnerCredentials(profileStore, options.providerAccountStore, owner);
    const currentCreds = isMaxRefreshCredentials(rawCurrentCreds) ? rawCurrentCreds : null;

    if (currentCreds && currentCreds.refreshToken === oauth.refreshToken) {
      logger.debug(
        { profileName, ...ownerLogFields(owner) },
        'Owner refresh token matches container — skipping persist',
      );
      return;
    }

    if (lineage) {
      if (!currentCreds) {
        logger.warn(
          {
            profileName,
            ...ownerLogFields(owner),
            lineageOwner: credentialOwnerKey(lineage.owner),
          },
          'Skipping MAX credential persist because credential owner no longer has MAX credentials',
        );
        return;
      }

      if (
        ownerKey !== credentialOwnerKey(lineage.owner) ||
        currentCreds.refreshToken !== lineage.issuedRefreshToken
      ) {
        logger.warn(
          {
            profileName,
            ...ownerLogFields(owner),
            lineageOwner: credentialOwnerKey(lineage.owner),
            ownerTokenChanged: currentCreds.refreshToken !== lineage.issuedRefreshToken,
          },
          'Skipping stale MAX credential persist because credential owner advanced since container issue',
        );
        return;
      }
    }

    const updated: MaxRefreshCredentials = {
      provider: 'max',
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: new Date(oauth.expiresAt).toISOString(),
      clientId: currentCreds?.clientId,
      scopes: currentCreds?.scopes,
      subscriptionType: currentCreds?.subscriptionType,
      rateLimitTier: currentCreds?.rateLimitTier,
    };

    await persistMaxCredentialsUnderLock(
      profileStore,
      options.providerAccountStore,
      owner,
      profileName,
      updated,
      logger,
    );
  });
}

export async function persistOpenAiAuthJson(
  containerId: string,
  containerManager: ContainerManager,
  profileStore: ProfileStore,
  profileName: string,
  logger: Logger,
  options: CredentialPersistenceOptions = {},
): Promise<void> {
  const owner = resolveExistingAuthOwner(profileStore, profileName, options);
  if (!owner) {
    logger.debug({ profileName }, 'Skipping Codex auth.json persist because no auth owner exists');
    return;
  }

  let rawContent: string;
  try {
    rawContent = await containerManager.readFile(containerId, CODEX_AUTH_PATH);
  } catch (err) {
    logger.debug(
      { err, containerId, profileName },
      'Could not read Codex auth.json from container',
    );
    return;
  }

  try {
    JSON.parse(rawContent);
  } catch (err) {
    logger.warn({ err, profileName }, 'Failed to parse Codex auth.json from container');
    return;
  }

  const ownerKey = credentialOwnerKey(owner);
  await withOwnerLock(ownerKey, async () => {
    const currentCreds = getOwnerCredentials(profileStore, options.providerAccountStore, owner);
    if (currentCreds && currentCreds.provider !== 'openai') {
      logger.warn(
        { profileName, ...ownerLogFields(owner), ownerProvider: currentCreds.provider },
        'Skipping Codex auth.json persist because credential owner is not OpenAI',
      );
      return;
    }

    if (currentCreds?.provider === 'openai' && currentCreds.authJson === rawContent) {
      logger.debug(
        { profileName, ...ownerLogFields(owner) },
        'Codex auth.json already matches credential owner — skipping persist',
      );
      return;
    }

    const updated: OpenAiCredentials = {
      provider: 'openai',
      authMode: 'chatgpt',
      authJson: rawContent,
    };
    updateOwnerCredentials(profileStore, options.providerAccountStore, owner, updated);
    logger.info(
      { profileName, ...ownerLogFields(owner) },
      'Persisted Codex auth.json to credential owner',
    );
  });
}

function parsePiCredential(
  rawContent: string,
  providerId: PiOAuthProviderId,
  profileName: string,
  logger: Logger,
): PiOAuthCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    logger.warn({ err, profileName }, 'Failed to parse Pi auth.json from container');
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.warn({ profileName }, 'Pi auth.json was not a provider credential object');
    return null;
  }

  const entries = parsed as Record<string, unknown>;
  const credential = entries[providerId];
  if (
    !credential ||
    typeof credential !== 'object' ||
    Array.isArray(credential) ||
    !['access', 'accessToken', 'token'].some((field) => {
      const value = (credential as Record<string, unknown>)[field];
      return typeof value === 'string' && value.trim().length > 0;
    })
  ) {
    logger.warn({ profileName, providerId }, 'Pi auth.json provider entry was malformed');
    return null;
  }

  return {
    provider: 'pi',
    providerId,
    credential: credential as Record<string, unknown>,
  };
}

export async function persistPiAuthJson(
  containerId: string,
  containerManager: ContainerManager,
  profileStore: ProfileStore,
  profileName: string,
  logger: Logger,
  options: CredentialPersistenceOptions = {},
): Promise<void> {
  const owner = resolveExistingAuthOwner(profileStore, profileName, options);
  if (!owner) {
    logger.debug({ profileName }, 'Skipping Pi auth.json persist because no auth owner exists');
    return;
  }

  let rawContent: string;
  try {
    rawContent = await containerManager.readFile(containerId, PI_AUTH_PATH);
  } catch (err) {
    logger.debug({ err, containerId, profileName }, 'Could not read Pi auth.json from container');
    return;
  }

  const ownerKey = credentialOwnerKey(owner);
  await withOwnerLock(ownerKey, async () => {
    const currentCreds = getOwnerCredentials(profileStore, options.providerAccountStore, owner);
    if (!currentCreds || currentCreds.provider !== 'pi') {
      logger.warn(
        {
          profileName,
          ...ownerLogFields(owner),
          ownerProvider: currentCreds?.provider ?? null,
        },
        'Skipping Pi auth.json persist because credential owner is not Pi',
      );
      return;
    }

    const updated = parsePiCredential(rawContent, currentCreds.providerId, profileName, logger);
    if (!updated) return;

    if (JSON.stringify(currentCreds.credential) === JSON.stringify(updated.credential)) {
      logger.debug(
        { profileName, ...ownerLogFields(owner), providerId: updated.providerId },
        'Pi auth.json already matches credential owner — skipping persist',
      );
      return;
    }

    updateOwnerCredentials(profileStore, options.providerAccountStore, owner, updated);
    logger.info(
      { profileName, ...ownerLogFields(owner), providerId: updated.providerId },
      'Persisted Pi auth.json to credential owner',
    );
  });
}
