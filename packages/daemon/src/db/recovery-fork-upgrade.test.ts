import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

it('upgrades v245 and retains immutable recovery request, actor, child lineage and facts after reopen', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'recovery-fork-upgrade-'));
  const old = path.join(root, 'v245');
  mkdirSync(old);
  const migrations = new URL('./migrations', import.meta.url).pathname;
  for (const file of readdirSync(migrations))
    if (file.endsWith('.sql') && Number.parseInt(file, 10) <= 245)
      copyFileSync(path.join(migrations, file), path.join(old, file));
  const logger = pino({ level: 'silent' });
  const filename = path.join(root, 'durable.db');
  let db = new Database(filename);
  try {
    runMigrations(db, old, logger);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 245 });
    runMigrations(db, migrations, logger);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 248 });
    expect(db.prepare('SELECT * FROM artifact_checks_recoveries').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM artifact_checks_recovery_events').all()).toEqual([]);
    // No FK to deletable pods/history: the source parent and admitted child remain auditable.
    db.prepare('INSERT INTO recovery_forks VALUES(?,?,?,?,?,?,?,?,?)').run(
      'operation',
      'retained-parent',
      'request',
      'actor',
      'hash',
      '{"version":1}',
      '{"version":1}',
      'old-process',
      '2026-11-10',
    );
    db.prepare('INSERT INTO recovery_fork_facts VALUES(?,?,?,?)').run(
      'operation',
      'admitted',
      '{"childPodId":"retained-child"}',
      '2026-11-10',
    );
    db.prepare('INSERT INTO recovery_fork_delivery_evidence VALUES(?,?,?,?,?)').run(
      'operation',
      'checks',
      'result-hash',
      '{"head":"checked-source"}',
      'now',
    );
    db.prepare('INSERT INTO recovery_fork_delivery_evidence VALUES(?,?,?,?,?)').run(
      'operation',
      'approval',
      'approval-hash',
      '{"actor":{"type":"human","userId":"operator"}}',
      'now',
    );
    db.close();
    db = new Database(filename);
    runMigrations(db, migrations, logger);
    expect(
      db.prepare('SELECT parent_pod_id,request_id,actor_id FROM recovery_forks').get(),
    ).toEqual({ parent_pod_id: 'retained-parent', request_id: 'request', actor_id: 'actor' });
    expect(db.prepare('SELECT evidence FROM recovery_fork_facts').get()).toEqual({
      evidence: '{"childPodId":"retained-child"}',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM recovery_fork_delivery_evidence').get()).toEqual({
      n: 2,
    });
    for (const sql of [
      'DELETE FROM recovery_forks',
      "UPDATE recovery_forks SET actor_id='other'",
      'DELETE FROM recovery_fork_facts',
      'DELETE FROM recovery_fork_delivery_evidence',
      "UPDATE recovery_fork_delivery_evidence SET evidence='{}'",
      "UPDATE recovery_fork_facts SET evidence='{}'",
    ])
      expect(() => db.exec(sql)).toThrow(/immutable|permanent|append-only/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
