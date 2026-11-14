import type {
  AgentRoute,
  ProviderAccountHealth,
  ProviderAccountHealthSource,
  ProviderFailoverTarget,
} from '@autopod/shared';
import { AutopodError } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from '../configuration/configuration-digest.js';
import type { ProviderAccountStore } from './provider-account-store.js';

type UnhealthyState = 'auth_revoked' | 'out_of_credits';

interface Row {
  state: 'ok' | UnhealthyState;
  source: ProviderAccountHealthSource;
  credential_generation: string;
  reason: string;
  actor: string | null;
  observed_at: string;
}

const UNKNOWN: ProviderAccountHealth = {
  state: 'unknown',
  observedAt: null,
  source: null,
  reason: null,
  actor: null,
};

export interface ProviderAccountHealthStore {
  /** Effective health; `unknown` when nothing applies to the current credentials. */
  current(accountId: string): ProviderAccountHealth;
  /** A definitive provider refusal of this account during a pod run. */
  recordFailure(accountId: string, state: UnhealthyState, reason: string, podId: string): void;
  /** A completed run proves the account served requests; clears only an unhealthy state. */
  recordSuccess(accountId: string, podId: string): void;
  /** Explicit human override (`ap accounts mark-ok`, or a human credential replacement). */
  markOk(accountId: string, actor: string, reason: string): ProviderAccountHealth;
}

/**
 * Passive, append-only account health (#566). A revoked login applies only to the
 * credentials it refused, so any later credential content makes it `unknown`. Exhausted
 * credits belong to the account, not the token, so token rotation does not clear them;
 * a completed run, a human credential replacement or an operator override does.
 */
export function createProviderAccountHealthStore(
  db: Database.Database,
  accounts: Pick<ProviderAccountStore, 'get'>,
): ProviderAccountHealthStore {
  const generation = (accountId: string): string => {
    const account = accounts.get(accountId);
    return configurationDigest({ createdAt: account.createdAt, credentials: account.credentials });
  };
  const latest = (accountId: string) =>
    db
      .prepare(
        `SELECT state, source, credential_generation, reason, actor, observed_at
         FROM provider_account_health_observations WHERE account_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(accountId) as Row | undefined;
  const insert = (
    accountId: string,
    state: Row['state'],
    source: ProviderAccountHealthSource,
    reason: string,
    podId: string | null,
    actor: string | null,
  ) =>
    db
      .prepare(
        `INSERT INTO provider_account_health_observations
         (account_id, state, source, credential_generation, reason, pod_id, actor, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        accountId,
        state,
        source,
        generation(accountId),
        reason.trim().slice(0, 1200) || 'No reason recorded',
        podId,
        actor,
        new Date().toISOString(),
      );
  const current = (accountId: string): ProviderAccountHealth => {
    const row = latest(accountId);
    if (!row) return UNKNOWN;
    if (row.state === 'auth_revoked' && row.credential_generation !== generation(accountId))
      return UNKNOWN;
    return {
      state: row.state,
      observedAt: row.observed_at,
      source: row.source,
      reason: row.reason,
      actor: row.actor,
    };
  };
  return {
    current,
    recordFailure(accountId, state, reason, podId) {
      insert(accountId, state, 'observed_failure', reason, podId, null);
    },
    recordSuccess(accountId, podId) {
      const state = current(accountId).state;
      if (state === 'auth_revoked' || state === 'out_of_credits')
        insert(accountId, 'ok', 'observed_success', 'A run on this account completed', podId, null);
    },
    markOk(accountId, actor, reason) {
      if (!actor.trim() || !reason.trim())
        throw new AutopodError(
          'Marking an account healthy requires an operator and a reason',
          'INVALID_INPUT',
          400,
        );
      insert(accountId, 'ok', 'operator_override', reason, null, actor.trim().slice(0, 256));
      return current(accountId);
    },
  };
}

export function isUnhealthyAccount(health: ProviderAccountHealth): boolean {
  return health.state === 'auth_revoked' || health.state === 'out_of_credits';
}

export function describeAccountHealth(accountId: string, health: ProviderAccountHealth): string {
  const label = health.state === 'auth_revoked' ? 'login revoked or expired' : 'out of credits';
  return `${accountId}: ${label} (observed ${health.observedAt ?? 'unknown'})`;
}

/**
 * Admission gate for a launch route. The primary account must not be known-unhealthy:
 * a run would be refused by the provider before doing any work.
 */
export function assertRouteAccountHealthy(
  route: Pick<AgentRoute, 'providerAccountId'> & { failover: ProviderFailoverTarget[] },
  health: Pick<ProviderAccountHealthStore, 'current'>,
): void {
  const primary = health.current(route.providerAccountId);
  if (!isUnhealthyAccount(primary)) return;
  const healthyAlternatives = route.failover
    .filter((target) => !isUnhealthyAccount(health.current(target.providerAccountId)))
    .map((target) => target.providerAccountId);
  throw new AutopodError(
    `Provider account unavailable: ${describeAccountHealth(route.providerAccountId, primary)}. ` +
      `${primary.state === 'auth_revoked' ? 'Re-authenticate the account' : 'Add credits to the provider account'}, ` +
      `then run \`ap accounts mark-ok ${route.providerAccountId} --reason <why>\` if no credential change is needed` +
      (healthyAlternatives.length > 0
        ? `, or select an AI preset whose primary account is healthy (${[...new Set(healthyAlternatives)].join(', ')}).`
        : '. No failover account on this route is known to be healthy.'),
    'PROVIDER_ACCOUNT_UNAVAILABLE',
    409,
  );
}
