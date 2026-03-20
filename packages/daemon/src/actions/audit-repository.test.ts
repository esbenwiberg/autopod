import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createActionAuditRepository } from './audit-repository.js';

const PROFILE_NAME = 'test-profile';
const SESSION_ID = 'sess-001';

function setupDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      name TEXT PRIMARY KEY, repo_url TEXT NOT NULL, default_branch TEXT NOT NULL DEFAULT 'main',
      template TEXT NOT NULL DEFAULT 'node22', build_command TEXT NOT NULL, start_command TEXT NOT NULL,
      health_path TEXT NOT NULL DEFAULT '/', health_timeout INTEGER NOT NULL DEFAULT 120,
      validation_pages TEXT NOT NULL DEFAULT '[]', max_validation_attempts INTEGER NOT NULL DEFAULT 3,
      default_model TEXT NOT NULL DEFAULT 'sonnet', default_runtime TEXT NOT NULL DEFAULT 'claude',
      escalation_config TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, profile_name TEXT NOT NULL REFERENCES profiles(name),
      task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      model TEXT NOT NULL DEFAULT 'sonnet', runtime TEXT NOT NULL DEFAULT 'claude',
      execution_target TEXT NOT NULL DEFAULT 'local', user_id TEXT, branch TEXT
    );

    CREATE TABLE IF NOT EXISTS action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      action_name TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
      response_summary TEXT DEFAULT NULL, pii_detected INTEGER NOT NULL DEFAULT 0,
      quarantine_score REAL NOT NULL DEFAULT 0.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO profiles (name, repo_url, build_command, start_command)
    VALUES ('${PROFILE_NAME}', 'https://github.com/test/repo', 'npm run build', 'npm start');

    INSERT INTO sessions (id, profile_name, task)
    VALUES ('${SESSION_ID}', '${PROFILE_NAME}', 'test task');
  `);

  return db;
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    actionName: 'deploy',
    params: { env: 'staging' },
    responseSummary: 'deployed ok',
    piiDetected: false,
    quarantineScore: 0.1,
    ...overrides,
  };
}

describe('ActionAuditRepository', () => {
  let db: InstanceType<typeof Database>;
  let repo: ReturnType<typeof createActionAuditRepository>;

  beforeEach(() => {
    db = setupDb();
    repo = createActionAuditRepository(db);
  });

  it('insert + listBySession round-trip', () => {
    const entry = makeEntry();
    repo.insert(entry);

    const results = repo.listBySession(SESSION_ID);
    expect(results).toHaveLength(1);

    const row = results[0];
    expect(row.id).toBeTypeOf('number');
    expect(row.sessionId).toBe(SESSION_ID);
    expect(row.actionName).toBe('deploy');
    expect(row.params).toEqual({ env: 'staging' });
    expect(row.responseSummary).toBe('deployed ok');
    expect(row.piiDetected).toBe(false);
    expect(row.quarantineScore).toBe(0.1);
    expect(row.createdAt).toBeTypeOf('string');
  });

  it('JSON round-trip for complex nested params', () => {
    const complexParams = {
      nested: { deep: { value: 42 } },
      list: [1, 'two', { three: true }],
      nullish: null,
    };
    repo.insert(makeEntry({ params: complexParams }));

    const [row] = repo.listBySession(SESSION_ID);
    expect(row.params).toEqual(complexParams);
  });

  it('piiDetected boolean conversion: true stored as 1, returned as true', () => {
    repo.insert(makeEntry({ piiDetected: true }));
    const [row] = repo.listBySession(SESSION_ID);
    expect(row.piiDetected).toBe(true);
  });

  it('piiDetected boolean conversion: false stored as 0, returned as false', () => {
    repo.insert(makeEntry({ piiDetected: false }));
    const [row] = repo.listBySession(SESSION_ID);
    expect(row.piiDetected).toBe(false);
  });

  it('listBySession respects limit', () => {
    for (let i = 0; i < 5; i++) {
      repo.insert(makeEntry({ actionName: `action-${i}` }));
    }

    const results = repo.listBySession(SESSION_ID, 2);
    expect(results).toHaveLength(2);
  });

  it('listBySession orders by created_at DESC', () => {
    // Manually insert with explicit created_at to guarantee ordering
    const stmt = db.prepare(`
      INSERT INTO action_audit (session_id, action_name, params, pii_detected, quarantine_score, created_at)
      VALUES (@sessionId, @actionName, '{}', 0, 0, @createdAt)
    `);
    stmt.run({ sessionId: SESSION_ID, actionName: 'first', createdAt: '2026-01-01 00:00:00' });
    stmt.run({ sessionId: SESSION_ID, actionName: 'second', createdAt: '2026-01-02 00:00:00' });
    stmt.run({ sessionId: SESSION_ID, actionName: 'third', createdAt: '2026-01-03 00:00:00' });

    const results = repo.listBySession(SESSION_ID);
    expect(results[0].actionName).toBe('third');
    expect(results[1].actionName).toBe('second');
    expect(results[2].actionName).toBe('first');
  });

  it('countBySession returns correct count', () => {
    repo.insert(makeEntry());
    repo.insert(makeEntry({ actionName: 'restart' }));
    repo.insert(makeEntry({ actionName: 'rollback' }));

    expect(repo.countBySession(SESSION_ID)).toBe(3);
  });

  it('countBySession returns 0 for unknown session', () => {
    expect(repo.countBySession('nonexistent')).toBe(0);
  });

  it('listBySession returns empty array for unknown session', () => {
    expect(repo.listBySession('nonexistent')).toEqual([]);
  });

  it('multiple sessions do not leak across queries', () => {
    const otherSessionId = 'sess-002';
    db.exec(`INSERT INTO sessions (id, profile_name, task) VALUES ('${otherSessionId}', '${PROFILE_NAME}', 'other task')`);

    repo.insert(makeEntry({ actionName: 'action-a' }));
    repo.insert(makeEntry({ sessionId: otherSessionId, actionName: 'action-b' }));

    const sess1Results = repo.listBySession(SESSION_ID);
    const sess2Results = repo.listBySession(otherSessionId);

    expect(sess1Results).toHaveLength(1);
    expect(sess1Results[0].actionName).toBe('action-a');

    expect(sess2Results).toHaveLength(1);
    expect(sess2Results[0].actionName).toBe('action-b');

    expect(repo.countBySession(SESSION_ID)).toBe(1);
    expect(repo.countBySession(otherSessionId)).toBe(1);
  });
});
