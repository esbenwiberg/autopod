import type {
  ModelProvider,
  ProviderAccount,
  ProviderCredentials,
  ProviderFailoverPolicy,
  ProviderFailoverTarget,
} from '@autopod/shared';
import {
  AutopodError,
  createProviderAccountSchema,
  updateProviderAccountSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import type { CredentialsCipher } from '../crypto/credentials-cipher.js';

export interface ProviderAccountStore {
  create(input: Record<string, unknown>): ProviderAccount;
  get(id: string): ProviderAccount;
  list(filter?: { provider?: ModelProvider }): ProviderAccount[];
  update(id: string, changes: Record<string, unknown>): ProviderAccount;
  updateCredentials(
    id: string,
    credentials: ProviderCredentials | null,
    options?: { authenticatedAt?: string | null; touchLastUsed?: boolean },
  ): ProviderAccount;
  touchLastUsed(id: string): void;
  delete(id: string): void;
  exists(id: string): boolean;
  listLinkedProfileNames(id: string): string[];
}

function slugifyProviderAccountId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return slug || 'provider-account';
}

function isSqliteConstraintError(err: unknown): boolean {
  return err instanceof Error && /constraint/i.test(err.message);
}

function rowToProviderAccount(
  row: Record<string, unknown>,
  decryptCredentials: (raw: unknown) => ProviderCredentials | null,
): ProviderAccount {
  return {
    id: row.id as string,
    name: row.name as string,
    provider: row.provider as ProviderAccount['provider'],
    credentials: decryptCredentials(row.credentials),
    failoverPolicy: parseFailoverPolicy(row.failover_policy),
    lastAuthenticatedAt: (row.last_authenticated_at as string | null | undefined) ?? null,
    lastUsedAt: (row.last_used_at as string | null | undefined) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function parseFailoverPolicy(raw: unknown): ProviderFailoverPolicy | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as ProviderFailoverPolicy;
  } catch {
    return null;
  }
}

function isRuntimeCompatible(target: ProviderFailoverTarget, account: ProviderAccount): boolean {
  switch (account.provider) {
    case 'anthropic':
    case 'max':
      return target.runtime === 'claude';
    case 'openai':
    case 'openrouter':
      return target.runtime === 'codex';
    case 'copilot':
      return target.runtime === 'copilot';
    case 'pi':
      return target.runtime === 'pi';
    case 'foundry':
      return account.credentials?.provider === 'foundry' &&
        account.credentials.apiSurface === 'openai'
        ? target.runtime === 'codex'
        : target.runtime === 'claude';
  }
}

export function createProviderAccountStore(
  db: Database.Database,
  cipher?: CredentialsCipher,
): ProviderAccountStore {
  function encryptCredentials(credentials: ProviderCredentials | null | undefined): string | null {
    if (!credentials) return null;
    const json = JSON.stringify(credentials);
    return cipher ? cipher.encrypt(json) : json;
  }

  function decryptCredentials(raw: unknown): ProviderCredentials | null {
    if (!raw) return null;
    const str = raw as string;
    try {
      const json = cipher ? cipher.decrypt(str) : str;
      return JSON.parse(json) as ProviderCredentials;
    } catch {
      try {
        return JSON.parse(str) as ProviderCredentials;
      } catch {
        return null;
      }
    }
  }

  function fetchRaw(id: string): ProviderAccount {
    const row = db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new AutopodError(
        `Provider account "${id}" not found`,
        'PROVIDER_ACCOUNT_NOT_FOUND',
        404,
      );
    }
    return rowToProviderAccount(row, decryptCredentials);
  }

  function listLinkedProfileNames(id: string): string[] {
    return (
      db
        .prepare('SELECT name FROM profiles WHERE provider_account_id = ? ORDER BY name')
        .all(id) as Array<{ name: string }>
    ).map((row) => row.name);
  }

  function assertCredentialsMatchProvider(
    provider: ModelProvider,
    credentials: ProviderCredentials | null | undefined,
  ): void {
    if (credentials && credentials.provider !== provider) {
      throw new AutopodError(
        `Provider account credentials are for "${credentials.provider}", not "${provider}"`,
        'PROVIDER_ACCOUNT_PROVIDER_MISMATCH',
        400,
      );
    }
  }

  function assertValidFailoverPolicy(
    sourceId: string,
    policy: ProviderFailoverPolicy | null,
    accountOverrides: ReadonlyMap<string, ProviderAccount> = new Map(),
  ): void {
    if (!policy) return;

    for (const target of policy.targets) {
      if (target.providerAccountId === sourceId) {
        throw new AutopodError(
          `Provider account "${sourceId}" cannot fail over to itself`,
          'PROVIDER_ACCOUNT_FAILOVER_SELF_REFERENCE',
          400,
        );
      }
      const targetAccount =
        accountOverrides.get(target.providerAccountId) ?? fetchRaw(target.providerAccountId);
      if (
        targetAccount.credentials === null &&
        !['anthropic', 'openai'].includes(targetAccount.provider)
      ) {
        throw new AutopodError(
          `Provider account "${target.providerAccountId}" is not authenticated`,
          'PROVIDER_ACCOUNT_FAILOVER_UNAUTHENTICATED',
          400,
        );
      }
      if (!isRuntimeCompatible(target, targetAccount)) {
        throw new AutopodError(
          `Runtime "${target.runtime}" is incompatible with provider "${targetAccount.provider}"`,
          'PROVIDER_ACCOUNT_FAILOVER_INCOMPATIBLE_RUNTIME',
          400,
        );
      }
    }

    const visited = new Set<string>();
    const reachesSource = (accountId: string): boolean => {
      if (accountId === sourceId) return true;
      if (visited.has(accountId)) return false;
      visited.add(accountId);
      const row = db
        .prepare('SELECT failover_policy FROM provider_accounts WHERE id = ?')
        .get(accountId) as { failover_policy?: string | null } | undefined;
      const targetPolicy = parseFailoverPolicy(row?.failover_policy);
      return (
        targetPolicy?.targets.some((target) => reachesSource(target.providerAccountId)) ?? false
      );
    };
    if (policy.targets.some((target) => reachesSource(target.providerAccountId))) {
      throw new AutopodError(
        `Failover policy for provider account "${sourceId}" would create a cycle`,
        'PROVIDER_ACCOUNT_FAILOVER_CYCLE',
        400,
      );
    }
  }

  function listFailoverReferrerIds(targetId: string): string[] {
    const rows = db
      .prepare(
        `SELECT id, failover_policy
         FROM provider_accounts
         WHERE failover_policy IS NOT NULL
         ORDER BY id`,
      )
      .all() as Array<{ id: string; failover_policy: string }>;
    return rows
      .filter((row) =>
        parseFailoverPolicy(row.failover_policy)?.targets.some(
          (target) => target.providerAccountId === targetId,
        ),
      )
      .map((row) => row.id);
  }

  function assertInboundPoliciesRemainValid(proposedAccount: ProviderAccount): void {
    const referrerIds = listFailoverReferrerIds(proposedAccount.id);
    if (referrerIds.length === 0) return;
    const overrides = new Map([[proposedAccount.id, proposedAccount]]);
    for (const referrerId of referrerIds) {
      const referrer = fetchRaw(referrerId);
      assertValidFailoverPolicy(referrer.id, referrer.failoverPolicy, overrides);
    }
  }

  return {
    create(input: Record<string, unknown>): ProviderAccount {
      const parsed = createProviderAccountSchema.parse(input);
      const id = parsed.id ?? slugifyProviderAccountId(parsed.name);
      const now = new Date().toISOString();
      assertValidFailoverPolicy(id, parsed.failoverPolicy);

      try {
        db.prepare(
          `INSERT INTO provider_accounts (
            id, name, provider, credentials, failover_policy,
            last_authenticated_at, last_used_at, created_at, updated_at
          ) VALUES (
            @id, @name, @provider, @credentials, @failoverPolicy,
            @lastAuthenticatedAt, NULL, @createdAt, @updatedAt
          )`,
        ).run({
          id,
          name: parsed.name,
          provider: parsed.provider,
          credentials: encryptCredentials(parsed.credentials),
          failoverPolicy:
            parsed.failoverPolicy === null ? null : JSON.stringify(parsed.failoverPolicy),
          lastAuthenticatedAt: parsed.credentials ? now : null,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err) {
        if (isSqliteConstraintError(err)) {
          throw new AutopodError(
            `Provider account "${parsed.name}" already exists`,
            'PROVIDER_ACCOUNT_EXISTS',
            409,
          );
        }
        throw err;
      }

      return fetchRaw(id);
    },

    get(id: string): ProviderAccount {
      return fetchRaw(id);
    },

    list(filter: { provider?: ModelProvider } = {}): ProviderAccount[] {
      const rows = filter.provider
        ? (db
            .prepare('SELECT * FROM provider_accounts WHERE provider = ? ORDER BY lower(name)')
            .all(filter.provider) as Record<string, unknown>[])
        : (db
            .prepare('SELECT * FROM provider_accounts ORDER BY provider, lower(name)')
            .all() as Record<string, unknown>[]);
      return rows.map((row) => rowToProviderAccount(row, decryptCredentials));
    },

    update(id: string, changes: Record<string, unknown>): ProviderAccount {
      const existing = fetchRaw(id);
      const parsed = updateProviderAccountSchema.parse(changes);
      if (parsed.credentials !== undefined) {
        assertCredentialsMatchProvider(existing.provider, parsed.credentials);
        assertInboundPoliciesRemainValid({ ...existing, credentials: parsed.credentials });
      }
      if (parsed.failoverPolicy !== undefined) {
        assertValidFailoverPolicy(id, parsed.failoverPolicy);
      }

      const setClauses: string[] = [];
      const fieldMap: Record<string, unknown> = { id };
      if (parsed.name !== undefined) {
        setClauses.push('name = @name');
        fieldMap.name = parsed.name;
      }
      if (parsed.credentials !== undefined) {
        setClauses.push('credentials = @credentials');
        fieldMap.credentials = encryptCredentials(parsed.credentials);
        setClauses.push('last_authenticated_at = @lastAuthenticatedAt');
        fieldMap.lastAuthenticatedAt = parsed.credentials ? new Date().toISOString() : null;
      }
      if (parsed.failoverPolicy !== undefined) {
        setClauses.push('failover_policy = @failoverPolicy');
        fieldMap.failoverPolicy =
          parsed.failoverPolicy === null ? null : JSON.stringify(parsed.failoverPolicy);
      }
      if (setClauses.length === 0) return existing;

      setClauses.push('updated_at = @updatedAt');
      fieldMap.updatedAt = new Date().toISOString();

      try {
        db.prepare(`UPDATE provider_accounts SET ${setClauses.join(', ')} WHERE id = @id`).run(
          fieldMap,
        );
      } catch (err) {
        if (isSqliteConstraintError(err)) {
          throw new AutopodError(
            `Provider account "${parsed.name ?? id}" already exists`,
            'PROVIDER_ACCOUNT_EXISTS',
            409,
          );
        }
        throw err;
      }

      return fetchRaw(id);
    },

    updateCredentials(
      id: string,
      credentials: ProviderCredentials | null,
      options: { authenticatedAt?: string | null; touchLastUsed?: boolean } = {},
    ): ProviderAccount {
      const existing = fetchRaw(id);
      assertCredentialsMatchProvider(existing.provider, credentials);
      assertInboundPoliciesRemainValid({ ...existing, credentials });
      const now = new Date().toISOString();
      const authenticatedAt =
        options.authenticatedAt === undefined
          ? credentials
            ? now
            : null
          : options.authenticatedAt;
      db.prepare(
        `UPDATE provider_accounts
         SET credentials = @credentials,
             last_authenticated_at = @lastAuthenticatedAt,
             last_used_at = CASE WHEN @touchLastUsed = 1 THEN @now ELSE last_used_at END,
             updated_at = @now
         WHERE id = @id`,
      ).run({
        id,
        credentials: encryptCredentials(credentials),
        lastAuthenticatedAt: authenticatedAt,
        touchLastUsed: options.touchLastUsed ? 1 : 0,
        now,
      });
      return fetchRaw(id);
    },

    touchLastUsed(id: string): void {
      fetchRaw(id);
      db.prepare(
        `UPDATE provider_accounts
         SET last_used_at = @now,
             updated_at = @now
         WHERE id = @id`,
      ).run({ id, now: new Date().toISOString() });
    },

    delete(id: string): void {
      fetchRaw(id);
      const failoverReferrers = listFailoverReferrerIds(id);
      if (failoverReferrers.length > 0) {
        throw new AutopodError(
          `Cannot delete provider account "${id}" while referenced by failover policies: ${failoverReferrers.join(', ')}`,
          'PROVIDER_ACCOUNT_FAILOVER_TARGET_IN_USE',
          409,
        );
      }
      const linkedProfiles = listLinkedProfileNames(id);
      if (linkedProfiles.length > 0) {
        throw new AutopodError(
          `Cannot delete provider account "${id}" while linked to profiles: ${linkedProfiles.join(', ')}`,
          'PROVIDER_ACCOUNT_IN_USE',
          409,
        );
      }
      db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(id);
    },

    exists(id: string): boolean {
      return db.prepare('SELECT 1 FROM provider_accounts WHERE id = ?').get(id) !== undefined;
    },

    listLinkedProfileNames(id: string): string[] {
      return listLinkedProfileNames(id);
    },
  };
}
