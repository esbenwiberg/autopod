import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  createHistoricalDiskDatabase,
  MIGRATIONS_DIR,
  openTestDiskDatabase,
} from '../test-utils/disk-database.js';
import { logger } from '../test-utils/mock-helpers.js';
import { runMigrations } from './migrate.js';

it('upgrades applied v253 without skipping draft tables or changing reviewer/publication evidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'saved-draft-upgrade-'));
  const filename = path.join(root, 'existing.db');
  let db = createHistoricalDiskDatabase(filename, [{ dir: MIGRATIONS_DIR, through: 253 }]);
  try {
    const prefixes = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => Number.parseInt(file, 10));
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes).toContain(254);
    db.prepare(
      'INSERT INTO pod_reviewer_budget_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      1,
      'retained-pod',
      'review-request',
      'a'.repeat(64),
      'b'.repeat(64),
      1,
      100,
      100,
      200,
      50,
      'c'.repeat(64),
      '{"measured":50}',
      'human',
      'Keep measured usage intact',
      'now',
    );
    const previousVersions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    const reviewer = db.prepare('SELECT * FROM pod_reviewer_budget_revisions').all();
    const publicationSchema = db
      .prepare("SELECT * FROM sqlite_master WHERE name='source_publication_resources'")
      .get();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='saved_work_draft_pr_operations'").get(),
    ).toBeUndefined();
    runMigrations(db, MIGRATIONS_DIR, logger);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: 270 });
    expect(
      db.prepare('SELECT * FROM schema_version WHERE version<=253 ORDER BY version').all(),
    ).toEqual(previousVersions);
    expect(db.prepare('SELECT * FROM pod_reviewer_budget_revisions').all()).toEqual(reviewer);
    expect(
      db.prepare("SELECT * FROM sqlite_master WHERE name='source_publication_resources'").get(),
    ).toEqual(publicationSchema);
    const body = JSON.stringify({
      generation: 1,
      repository: 'https://github.com/org/repo',
      baseBranch: 'main',
      source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      state: 'create-uncertain',
    });
    db.prepare('INSERT INTO saved_work_draft_pr_operations VALUES(?,?,?,?,?)').run(
      'operation',
      'pod',
      'request',
      'human',
      body,
    );
    db.prepare('INSERT INTO saved_work_draft_pr_preparation_cancellations VALUES(?,?,?)').run(
      'other-pod',
      'revoked-request',
      '{"actorId":"human","state":"cancelled-before-publication"}',
    );
    db.close();
    db = openTestDiskDatabase(filename);
    runMigrations(db, MIGRATIONS_DIR, logger);
    expect(db.prepare('SELECT body FROM saved_work_draft_pr_operations').get()).toEqual({ body });
    expect(
      db.prepare('SELECT request_id FROM saved_work_draft_pr_preparation_cancellations').get(),
    ).toEqual({ request_id: 'revoked-request' });
    expect(() =>
      db
        .prepare('INSERT INTO saved_work_draft_pr_operations VALUES(?,?,?,?,?)')
        .run('duplicate', 'pod', 'new-request', 'human', body),
    ).toThrow(/UNIQUE/);
    expect(() => db.exec('DELETE FROM pod_reviewer_budget_revisions')).toThrow(/retained/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
