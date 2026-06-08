import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createActionAuditRepository } from './audit-repository.js';

const PROFILE_NAME = 'test-profile';
const POD_ID = 'sess-001';

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

    CREATE TABLE IF NOT EXISTS pods (
      id TEXT PRIMARY KEY, profile_name TEXT NOT NULL REFERENCES profiles(name),
      task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      model TEXT NOT NULL DEFAULT 'sonnet', runtime TEXT NOT NULL DEFAULT 'claude',
      execution_target TEXT NOT NULL DEFAULT 'local', user_id TEXT, branch TEXT
    );

    CREATE TABLE IF NOT EXISTS action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
      action_name TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
      response_summary TEXT DEFAULT NULL, pii_detected INTEGER NOT NULL DEFAULT 0,
      quarantine_score REAL NOT NULL DEFAULT 0.0,
      pii_categories TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      prev_hash TEXT DEFAULT NULL,
      entry_hash TEXT DEFAULT NULL
    );

    INSERT INTO profiles (name, repo_url, build_command, start_command)
    VALUES ('${PROFILE_NAME}', 'https://github.com/test/repo', 'npm run build', 'npm start');

    INSERT INTO pods (id, profile_name, task)
    VALUES ('${POD_ID}', '${PROFILE_NAME}', 'test task');
  `);

  return db;
}

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    podId: POD_ID,
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

    const results = repo.listBySession(POD_ID);
    expect(results).toHaveLength(1);

    const row = results[0];
    expect(row.id).toBeTypeOf('number');
    expect(row.podId).toBe(POD_ID);
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

    const [row] = repo.listBySession(POD_ID);
    expect(row.params).toEqual(complexParams);
  });

  it('piiDetected boolean conversion: true stored as 1, returned as true', () => {
    repo.insert(makeEntry({ piiDetected: true }));
    const [row] = repo.listBySession(POD_ID);
    expect(row.piiDetected).toBe(true);
  });

  it('piiDetected boolean conversion: false stored as 0, returned as false', () => {
    repo.insert(makeEntry({ piiDetected: false }));
    const [row] = repo.listBySession(POD_ID);
    expect(row.piiDetected).toBe(false);
  });

  it('listBySession respects limit', () => {
    for (let i = 0; i < 5; i++) {
      repo.insert(makeEntry({ actionName: `action-${i}` }));
    }

    const results = repo.listBySession(POD_ID, 2);
    expect(results).toHaveLength(2);
  });

  it('listBySession orders by created_at DESC', () => {
    // Manually insert with explicit created_at to guarantee ordering
    const stmt = db.prepare(`
      INSERT INTO action_audit (pod_id, action_name, params, pii_detected, quarantine_score, created_at)
      VALUES (@podId, @actionName, '{}', 0, 0, @createdAt)
    `);
    stmt.run({ podId: POD_ID, actionName: 'first', createdAt: '2026-01-01 00:00:00' });
    stmt.run({ podId: POD_ID, actionName: 'second', createdAt: '2026-01-02 00:00:00' });
    stmt.run({ podId: POD_ID, actionName: 'third', createdAt: '2026-01-03 00:00:00' });

    const results = repo.listBySession(POD_ID);
    expect(results[0].actionName).toBe('third');
    expect(results[1].actionName).toBe('second');
    expect(results[2].actionName).toBe('first');
  });

  it('listBySession applies until before limit', () => {
    const stmt = db.prepare(`
      INSERT INTO action_audit (pod_id, action_name, params, pii_detected, quarantine_score, created_at)
      VALUES (@podId, @actionName, '{}', 0, 0, @createdAt)
    `);
    stmt.run({ podId: POD_ID, actionName: 'first', createdAt: '2026-01-01 00:00:00' });
    stmt.run({ podId: POD_ID, actionName: 'second', createdAt: '2026-01-02 00:00:00' });
    stmt.run({ podId: POD_ID, actionName: 'later', createdAt: '2026-01-03 00:00:00' });

    const results = repo.listBySession(POD_ID, 1, new Date('2026-01-02T00:00:00Z'));
    expect(results.map((row) => row.actionName)).toEqual(['second']);
  });

  it('countBySession returns correct count', () => {
    repo.insert(makeEntry());
    repo.insert(makeEntry({ actionName: 'restart' }));
    repo.insert(makeEntry({ actionName: 'rollback' }));

    expect(repo.countBySession(POD_ID)).toBe(3);
  });

  it('countBySession returns 0 for unknown pod', () => {
    expect(repo.countBySession('nonexistent')).toBe(0);
  });

  it('listBySession returns empty array for unknown pod', () => {
    expect(repo.listBySession('nonexistent')).toEqual([]);
  });

  it('pii_categories round-trip: array stored and returned correctly', () => {
    repo.insert(makeEntry({ piiCategories: ['api-key', 'email'] }));
    const [row] = repo.listBySession(POD_ID);
    expect(row?.piiCategories).toEqual(['api-key', 'email']);
  });

  it('pii_categories round-trip: null stored and returned as null', () => {
    repo.insert(makeEntry({ piiCategories: null }));
    const [row] = repo.listBySession(POD_ID);
    expect(row?.piiCategories).toBeNull();
  });

  it('pii_categories round-trip: undefined (not provided) stored and returned as null', () => {
    repo.insert(makeEntry()); // no piiCategories field
    const [row] = repo.listBySession(POD_ID);
    expect(row?.piiCategories).toBeNull();
  });

  it('multiple pods do not leak across queries', () => {
    const otherSessionId = 'sess-002';
    db.exec(
      `INSERT INTO pods (id, profile_name, task) VALUES ('${otherSessionId}', '${PROFILE_NAME}', 'other task')`,
    );

    repo.insert(makeEntry({ actionName: 'action-a' }));
    repo.insert(makeEntry({ podId: otherSessionId, actionName: 'action-b' }));

    const sess1Results = repo.listBySession(POD_ID);
    const sess2Results = repo.listBySession(otherSessionId);

    expect(sess1Results).toHaveLength(1);
    expect(sess1Results[0].actionName).toBe('action-a');

    expect(sess2Results).toHaveLength(1);
    expect(sess2Results[0].actionName).toBe('action-b');

    expect(repo.countBySession(POD_ID)).toBe(1);
    expect(repo.countBySession(otherSessionId)).toBe(1);
  });
});

describe('ActionAuditRepository — hash chain', () => {
  let db: InstanceType<typeof Database>;
  let repo: ReturnType<typeof createActionAuditRepository>;

  beforeEach(() => {
    db = setupDb();
    repo = createActionAuditRepository(db);
  });

  it('first entry has null prevHash and a non-null entryHash', () => {
    repo.insert(makeEntry());
    const [row] = repo.listBySession(POD_ID);
    expect(row.prevHash).toBeNull();
    expect(row.entryHash).toBeTypeOf('string');
    expect(row.entryHash).toHaveLength(64); // hex SHA-256
  });

  it('second entry prevHash equals first entry entryHash', () => {
    repo.insert(makeEntry({ actionName: 'first' }));
    repo.insert(makeEntry({ actionName: 'second' }));

    const rows = repo.listBySession(POD_ID, 10);
    // listBySession returns DESC; reverse to get insertion order
    const [first, second] = rows.reverse();
    expect(second.prevHash).toBe(first.entryHash);
  });

  it('verifyAuditChain returns valid for empty pod', () => {
    const result = repo.verifyAuditChain(POD_ID);
    expect(result.valid).toBe(true);
    expect(result.rowCount).toBe(0);
  });

  it('verifyAuditChain passes for a clean sequence', () => {
    repo.insert(makeEntry({ actionName: 'a' }));
    repo.insert(makeEntry({ actionName: 'b' }));
    repo.insert(makeEntry({ actionName: 'c' }));

    const result = repo.verifyAuditChain(POD_ID);
    expect(result.valid).toBe(true);
    expect(result.rowCount).toBe(3);
  });

  it('verifyAuditChain detects a tampered entry_hash', () => {
    repo.insert(makeEntry({ actionName: 'legit' }));

    // Simulate a direct-DB tamper (immutability enforced at app layer; this tests
    // that verifyAuditChain catches such tampering).
    db.prepare('UPDATE action_audit SET entry_hash = @bad WHERE pod_id = @podId').run({
      bad: 'deadbeef'.repeat(8),
      podId: POD_ID,
    });

    const result = repo.verifyAuditChain(POD_ID);
    expect(result.valid).toBe(false);
    expect(result.firstBadId).toBeTypeOf('number');
  });

  it('repository interface has no update or delete methods (application-layer immutability)', () => {
    // The ActionAuditRepository interface intentionally exposes no update/delete —
    // immutability is enforced by the absence of mutating methods. verifyAuditChain()
    // detects any tampering done directly against the database.
    expect(typeof (repo as Record<string, unknown>).update).toBe('undefined');
    expect(typeof (repo as Record<string, unknown>).delete).toBe('undefined');
  });

  // ─── ADR-019 hash-stability gate ────────────────────────────────────────
  // pii_categories must NOT be included in the hash payload. If it were, any
  // write of pii_categories would invalidate the entire chain — breaking
  // existing rows already stored without the column.

  it('entry_hash is identical regardless of piiCategories value (ADR-019)', () => {
    // Insert two entries that differ ONLY in piiCategories
    db.exec(
      `INSERT INTO pods (id, profile_name, task) VALUES ('sess-hash-a', '${PROFILE_NAME}', 'hash-test-a')`,
    );
    db.exec(
      `INSERT INTO pods (id, profile_name, task) VALUES ('sess-hash-b', '${PROFILE_NAME}', 'hash-test-b')`,
    );

    const repoA = createActionAuditRepository(
      (() => {
        const d = setupDb();
        d.exec(
          `INSERT INTO pods (id, profile_name, task) VALUES ('sess-hash-null', '${PROFILE_NAME}', 'h')`,
        );
        return d;
      })(),
    );
    const repoB = createActionAuditRepository(
      (() => {
        const d = setupDb();
        d.exec(
          `INSERT INTO pods (id, profile_name, task) VALUES ('sess-hash-null', '${PROFILE_NAME}', 'h')`,
        );
        return d;
      })(),
    );

    const baseEntry = {
      podId: 'sess-hash-null',
      actionName: 'deploy',
      params: { env: 'staging' },
      responseSummary: 'done',
      piiDetected: false,
      quarantineScore: 0.0,
    };

    repoA.insert({ ...baseEntry, piiCategories: null });
    repoB.insert({ ...baseEntry, piiCategories: ['api-key', 'email'] });

    const [rowA] = repoA.listBySession('sess-hash-null');
    const [rowB] = repoB.listBySession('sess-hash-null');

    // The entry hashes must be identical — piiCategories is NOT in the hash payload
    expect(rowA?.entryHash).toBeTruthy();
    expect(rowB?.entryHash).toBeTruthy();
    expect(rowA?.entryHash).toBe(rowB?.entryHash);
  });

  it('hash chains are independent across pods', () => {
    const OTHER = 'sess-002';
    db.exec(
      `INSERT INTO pods (id, profile_name, task) VALUES ('${OTHER}', '${PROFILE_NAME}', 'other')`,
    );

    repo.insert(makeEntry({ actionName: 'pod1-first' }));
    repo.insert(makeEntry({ podId: OTHER, actionName: 'pod2-first' }));

    const r1 = repo.verifyAuditChain(POD_ID);
    const r2 = repo.verifyAuditChain(OTHER);
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);

    // First entries of each pod both have null prevHash (independent chains)
    const rows1 = repo.listBySession(POD_ID);
    const rows2 = repo.listBySession(OTHER);
    expect(rows1[0].prevHash).toBeNull();
    expect(rows2[0].prevHash).toBeNull();
  });
});
