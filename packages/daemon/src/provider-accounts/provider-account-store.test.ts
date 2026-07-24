import { describe, expect, it } from 'vitest';
import type { CredentialsCipher } from '../crypto/credentials-cipher.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { createProviderAccountStore } from './provider-account-store.js';

const reversibleCipher: CredentialsCipher = {
  encrypt(value: string): string {
    return `enc:${Buffer.from(value, 'utf8').toString('base64')}`;
  },
  decrypt(value: string): string {
    if (!value.startsWith('enc:')) throw new Error('not encrypted');
    return Buffer.from(value.slice(4), 'base64').toString('utf8');
  },
};

describe('ProviderAccountStore', () => {
  it('round-trips ordered failover defaults and preserves null for legacy rows', () => {
    const db = createTestDb();
    const store = createProviderAccountStore(db);
    store.create({
      id: 'claude-max',
      name: 'Claude Max',
      provider: 'max',
      credentials: { provider: 'max', oauthToken: 'max-token' },
    });
    store.create({
      id: 'copilot',
      name: 'Copilot',
      provider: 'copilot',
      credentials: { provider: 'copilot', token: 'copilot-token' },
    });
    const source = store.create({
      id: 'openai-primary',
      name: 'OpenAI Primary',
      provider: 'openai',
      failoverPolicy: {
        targets: [
          { providerAccountId: 'claude-max', runtime: 'claude', model: 'opus' },
          { providerAccountId: 'copilot', runtime: 'copilot', model: 'auto' },
        ],
        maxHops: 2,
      },
    });
    expect(source.failoverPolicy?.targets.map((target) => target.providerAccountId)).toEqual([
      'claude-max',
      'copilot',
    ]);

    const updated = store.update(source.id, {
      failoverPolicy: {
        targets: [
          { providerAccountId: 'copilot', runtime: 'copilot', model: 'auto' },
          { providerAccountId: 'claude-max', runtime: 'claude', model: 'sonnet' },
        ],
        maxHops: 1,
      },
    });
    expect(updated.failoverPolicy).toEqual({
      targets: [
        { providerAccountId: 'copilot', runtime: 'copilot', model: 'auto' },
        { providerAccountId: 'claude-max', runtime: 'claude', model: 'sonnet' },
      ],
      maxHops: 1,
    });

    db.prepare(
      `INSERT INTO provider_accounts (id, name, provider, created_at, updated_at)
       VALUES ('legacy', 'Legacy', 'anthropic', datetime('now'), datetime('now'))`,
    ).run();
    expect(store.get('legacy').failoverPolicy).toBeNull();
    expect(store.update(source.id, { failoverPolicy: null }).failoverPolicy).toBeNull();
  });

  it('rejects invalid failover defaults without changing the existing policy', () => {
    const db = createTestDb();
    const store = createProviderAccountStore(db);
    store.create({
      id: 'claude-max',
      name: 'Claude Max',
      provider: 'max',
      credentials: { provider: 'max', oauthToken: 'max-token' },
    });
    store.create({
      id: 'copilot',
      name: 'Copilot',
      provider: 'copilot',
      credentials: { provider: 'copilot', token: 'copilot-token' },
    });
    store.create({ id: 'unauthenticated', name: 'Unauthenticated', provider: 'copilot' });
    const source = store.create({ id: 'primary', name: 'Primary', provider: 'openai' });
    const validPolicy = {
      targets: [{ providerAccountId: 'claude-max', runtime: 'claude', model: 'opus' as const }],
      maxHops: 1,
    };
    store.update(source.id, { failoverPolicy: validPolicy });

    const invalidPolicies = [
      { targets: [{ providerAccountId: 'primary', runtime: 'codex', model: 'gpt-5' }] },
      {
        targets: [
          { providerAccountId: 'copilot', runtime: 'copilot', model: 'auto' },
          { providerAccountId: 'copilot', runtime: 'copilot', model: 'gpt-5' },
        ],
      },
      { targets: [{ providerAccountId: 'missing', runtime: 'claude', model: 'opus' }] },
      {
        targets: [{ providerAccountId: 'unauthenticated', runtime: 'copilot', model: 'auto' }],
      },
      { targets: [{ providerAccountId: 'claude-max', runtime: 'codex', model: 'gpt-5' }] },
      { targets: [{ providerAccountId: 'copilot', runtime: 'copilot' }] },
      { targets: [] },
      {
        targets: [{ providerAccountId: 'copilot', runtime: 'copilot', model: 'auto' }],
        maxHops: 2,
      },
    ];

    for (const failoverPolicy of invalidPolicies) {
      expect(() => store.update(source.id, { failoverPolicy })).toThrow();
      expect(store.get(source.id).failoverPolicy).toEqual(validPolicy);
    }
  });

  it('rejects failover cycles across provider accounts', () => {
    const db = createTestDb();
    const store = createProviderAccountStore(db);
    store.create({ id: 'one', name: 'One', provider: 'openai' });
    store.create({
      id: 'two',
      name: 'Two',
      provider: 'max',
      credentials: { provider: 'max', oauthToken: 'max-token' },
    });
    store.update('one', {
      failoverPolicy: {
        targets: [{ providerAccountId: 'two', runtime: 'claude', model: 'opus' }],
      },
    });
    expect(() =>
      store.update('two', {
        failoverPolicy: {
          targets: [{ providerAccountId: 'one', runtime: 'codex', model: 'gpt-5' }],
        },
      }),
    ).toThrow(/cycle/);
  });

  it('creates, reads, lists, updates, and deletes provider accounts', () => {
    const db = createTestDb();
    const store = createProviderAccountStore(db, reversibleCipher);

    const created = store.create({
      name: 'Team OpenAI',
      provider: 'openai',
      credentials: {
        provider: 'openai',
        authMode: 'chatgpt',
        authJson: '{"tokens":{"access_token":"secret"}}',
      },
    });

    expect(created.id).toBe('team-openai');
    expect(created.provider).toBe('openai');
    expect(created.credentials).toEqual({
      provider: 'openai',
      authMode: 'chatgpt',
      authJson: '{"tokens":{"access_token":"secret"}}',
    });
    expect(created.lastAuthenticatedAt).not.toBeNull();

    const encrypted = db
      .prepare('SELECT credentials FROM provider_accounts WHERE id = ?')
      .get(created.id) as { credentials: string };
    expect(encrypted.credentials).toMatch(/^enc:/);
    expect(encrypted.credentials).not.toContain('secret');

    expect(store.list()).toHaveLength(1);
    expect(store.list({ provider: 'openai' })).toHaveLength(1);
    expect(store.list({ provider: 'max' })).toHaveLength(0);

    const updated = store.update(created.id, { name: 'Shared OpenAI' });
    expect(updated.name).toBe('Shared OpenAI');

    store.delete(created.id);
    expect(store.exists(created.id)).toBe(false);
  });

  it('enforces case-insensitive unique account names', () => {
    const db = createTestDb();
    const store = createProviderAccountStore(db);

    store.create({ name: 'Claude Max', provider: 'max' });

    expect(() => store.create({ name: 'claude max', provider: 'max' })).toThrow(/already exists/);
  });

  it('rejects credentials that do not match the account provider', () => {
    const db = createTestDb();
    const store = createProviderAccountStore(db);

    expect(() =>
      store.create({
        name: 'Wrong creds',
        provider: 'openai',
        credentials: { provider: 'copilot', token: 'gho_token' },
      }),
    ).toThrow(/must match/);

    const account = store.create({ name: 'Copilot', provider: 'copilot' });
    expect(() =>
      store.updateCredentials(account.id, {
        provider: 'openai',
        authJson: '{"tokens":{}}',
      }),
    ).toThrow(/not "copilot"/);
  });

  it('tracks last-used metadata without exposing credentials through list filters', () => {
    const db = createTestDb();
    const store = createProviderAccountStore(db);

    const account = store.create({
      name: 'Copilot',
      provider: 'copilot',
      credentials: { provider: 'copilot', token: 'gho_token' },
    });
    expect(account.lastUsedAt).toBeNull();

    store.touchLastUsed(account.id);
    expect(store.get(account.id).lastUsedAt).not.toBeNull();
  });

  it('prevents deleting an account while profiles still link to it', () => {
    const db = createTestDb();
    const store = createProviderAccountStore(db);
    const account = store.create({ name: 'Team OpenAI', provider: 'openai' });

    db.prepare(`
      INSERT INTO profiles (
        name, repo_url, default_branch, template, build_command, start_command,
        health_path, health_timeout, validation_pages, max_validation_attempts,
        default_model, default_runtime, escalation_config, model_provider, provider_account_id
      ) VALUES (
        'linked', 'https://github.com/org/repo', 'main', 'node22', 'npm run build', 'npm start',
        '/', 120, '[]', 3, 'claude-opus-4-8', 'codex', '{}', 'openai', @accountId
      )
    `).run({ accountId: account.id });

    expect(store.listLinkedProfileNames(account.id)).toEqual(['linked']);
    expect(() => store.delete(account.id)).toThrow(/linked/);
  });
});
