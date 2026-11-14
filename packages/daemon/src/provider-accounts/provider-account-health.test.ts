import { describe, expect, it } from 'vitest';
import { resolveLaunch } from '../configuration/launch-resolver.js';
import { createTestConfiguration } from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createProviderAccountHealthStore } from './provider-account-health.js';
import { createProviderAccountStore } from './provider-account-store.js';

function fixture() {
  const db = createTestDb();
  const accounts = createProviderAccountStore(db);
  for (const id of ['account', 'backup'])
    accounts.create({
      id,
      name: id,
      provider: 'anthropic',
      credentials: { provider: 'anthropic', apiKey: `${id}-key-1` },
    });
  const health = createProviderAccountHealthStore(db, accounts);
  return { db, accounts, health };
}

describe('provider account health', () => {
  it('scopes a revoked login to the refused credentials', () => {
    const f = fixture();
    expect(f.health.current('account').state).toBe('unknown');
    f.health.recordFailure('account', 'auth_revoked', 'OAuth token revoked', 'pod-1');
    expect(f.health.current('account')).toMatchObject({
      state: 'auth_revoked',
      source: 'observed_failure',
      reason: 'OAuth token revoked',
    });
    f.accounts.updateCredentials('account', { provider: 'anthropic', apiKey: 'account-key-2' });
    expect(f.health.current('account').state).toBe('unknown');
  });

  it('keeps exhausted credits across credential rotation until success or override', () => {
    const f = fixture();
    f.health.recordFailure('account', 'out_of_credits', 'Out of credits', 'pod-1');
    f.accounts.updateCredentials('account', { provider: 'anthropic', apiKey: 'rotated' });
    expect(f.health.current('account').state).toBe('out_of_credits');
    f.health.recordSuccess('account', 'pod-2');
    expect(f.health.current('account')).toMatchObject({ state: 'ok', source: 'observed_success' });
    f.health.recordFailure('account', 'out_of_credits', 'Out of credits', 'pod-3');
    expect(() => f.health.markOk('account', 'operator', ' ')).toThrow('requires');
    expect(f.health.markOk('account', 'operator', 'Credits added')).toMatchObject({
      state: 'ok',
      source: 'operator_override',
      actor: 'operator',
      reason: 'Credits added',
    });
  });

  it('records success only to clear a known-unhealthy state', () => {
    const f = fixture();
    f.health.recordSuccess('account', 'pod-1');
    expect(f.health.current('account').state).toBe('unknown');
    expect(
      f.db.prepare('SELECT COUNT(*) AS n FROM provider_account_health_observations').get(),
    ).toEqual({ n: 0 });
  });

  it('keeps observations append-only', () => {
    const f = fixture();
    f.health.recordFailure('account', 'auth_revoked', 'revoked', 'pod-1');
    expect(() => f.db.prepare('DELETE FROM provider_account_health_observations').run()).toThrow(
      'retained',
    );
    expect(() =>
      f.db.prepare("UPDATE provider_account_health_observations SET state = 'ok'").run(),
    ).toThrow('append-only');
  });

  it('rejects a launch whose primary account is known-unhealthy before resources exist', async () => {
    const f = fixture();
    const { services } = createTestConfiguration(f.db);
    const request = { repositoryId: 'repo-a', task: 'Work' };
    const gated = { ...services, agentAccountHealth: f.health };
    await expect(resolveLaunch(request, gated)).resolves.toBeTruthy();
    f.health.recordFailure('account', 'out_of_credits', 'Your workspace is out of credits.', 'p');
    await expect(resolveLaunch(request, gated)).rejects.toMatchObject({
      code: 'PROVIDER_ACCOUNT_UNAVAILABLE',
      message: expect.stringContaining('ap accounts mark-ok account'),
    });
    // Hosts without health evidence keep their existing admission behaviour.
    await expect(resolveLaunch(request, services)).resolves.toBeTruthy();
    f.health.markOk('account', 'operator', 'Credits added');
    await expect(resolveLaunch(request, gated)).resolves.toBeTruthy();
  });

  it('names healthy failover accounts when only the primary is refused', async () => {
    const f = fixture();
    const { services, store } = createTestConfiguration(f.db);
    const ai = store.get('ai', 'ai');
    store.writeBatch([
      {
        id: 'ai',
        kind: 'ai',
        name: ai.name,
        expectedRevision: ai.revision,
        payload: {
          main: {
            providerAccountId: 'account',
            runtime: 'claude',
            model: 'claude-sonnet-4-6',
            failover: [
              { providerAccountId: 'backup', runtime: 'claude', model: 'claude-sonnet-4-6' },
            ],
          },
        },
      },
    ]);
    f.health.recordFailure('account', 'auth_revoked', 'OAuth token revoked', 'p');
    await expect(
      resolveLaunch(
        { repositoryId: 'repo-a', task: 'Work' },
        { ...services, agentAccountHealth: f.health },
      ),
    ).rejects.toThrow('primary account is healthy (backup)');
  });
});
