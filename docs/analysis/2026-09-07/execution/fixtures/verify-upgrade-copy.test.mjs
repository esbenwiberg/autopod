import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrationHash, verifyUpgradeCopy } from './verify-upgrade-copy.mjs';

const root = process.cwd();
const require = createRequire(path.join(root, 'packages/daemon/package.json'));
const Database = require('better-sqlite3');
const { runMigrations } = await import(pathToFileURL(process.env.CANDIDATE_MIGRATION_BUNDLE).href);
const migrationsDir = path.join(root, 'packages/daemon/src/db/migrations');
const logger = { info() {}, warn() {}, debug() {}, error() {} };
const cli = path.join(
  path.dirname(process.env.CANDIDATE_MIGRATION_BUNDLE),
  'verify-upgrade-copy-cli.mjs',
);

function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-copy-test-'));
  const baseline = path.join(directory, 'baseline');
  fs.mkdirSync(baseline);
  for (const name of fs.readdirSync(migrationsDir)) {
    if (Number.parseInt(name, 10) <= 152)
      fs.copyFileSync(path.join(migrationsDir, name), path.join(baseline, name));
  }
  const snapshot = path.join(directory, 'snapshot.db');
  const db = new Database(snapshot);
  runMigrations(db, baseline, logger);
  db.exec("INSERT INTO profiles(name,repo_url) VALUES ('fixture','https://example.test/repo');");
  db.exec(
    "INSERT INTO pods(id,profile_name,task,status,model,runtime,branch,user_id,task_summary) VALUES ('retained','fixture','Preserve the original decision','failed','fixture','codex','fixture','fixture','malformed-retained-summary');",
  );
  db.close();
  const expectedSnapshotHash = createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex');
  const options = {
    Database,
    runMigrations,
    snapshot,
    expectedSnapshotHash,
    migrationsDir,
    expectedMigrationHash: migrationHash(migrationsDir),
    scratchParent: directory,
  };
  try {
    run(options);
    assert.equal(
      createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex'),
      expectedSnapshotHash,
    );
    assert.equal(
      fs.readdirSync(directory).filter((name) => name.startsWith('autopod-upgrade-')).length,
      0,
    );
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}

test('actual candidate upgrades a managed-152 copy and preserves original data', () =>
  fixture((options) => {
    const receipt = verifyUpgradeCopy(options);
    assert.equal(receipt.status, 'isolated_upgrade_verified');
    assert.equal(receipt.beforeVersion, 152);
    assert.equal(receipt.afterVersion, 183);
    assert.equal(receipt.retainedOriginalColumnsAndRows, true);
    assert.equal(receipt.taskBackfillOk, true);
    assert.equal(receipt.isolatedDirectoryRemoved, true);
  }));

test('wrong snapshot hash refuses before migration and retains source', () =>
  fixture((options) => {
    let invoked = false;
    const receipt = verifyUpgradeCopy({
      ...options,
      expectedSnapshotHash: '0'.repeat(64),
      runMigrations() {
        invoked = true;
      },
    });
    assert.equal(receipt.status, 'incomplete');
    assert.equal(invoked, false);
  }));

test('wrong migration identity refuses before migration', () =>
  fixture((options) => {
    let invoked = false;
    assert.equal(
      verifyUpgradeCopy({
        ...options,
        expectedMigrationHash: '0'.repeat(64),
        runMigrations() {
          invoked = true;
        },
      }).status,
      'incomplete',
    );
    assert.equal(invoked, false);
  }));

test('WAL sidecar refuses a non-standalone snapshot', () =>
  fixture((options) => {
    fs.writeFileSync(`${options.snapshot}-wal`, 'fixture');
    assert.equal(verifyUpgradeCopy(options).status, 'incomplete');
  }));

test('seeded migration that changes original retained content is detected and isolated copy removed', () =>
  fixture((options) => {
    const receipt = verifyUpgradeCopy({
      ...options,
      runMigrations(db, ...args) {
        runMigrations(db, ...args);
        db.prepare("UPDATE pods SET task_summary='lost' WHERE id='retained'").run();
      },
    });
    assert.equal(receipt.status, 'incomplete');
    assert.equal(receipt.isolatedDirectoryRemoved, true);
  }));

test('migration exceptions export no raw private error text', () =>
  fixture((options) => {
    const receipt = verifyUpgradeCopy({
      ...options,
      runMigrations() {
        throw new Error('private-row-sentinel');
      },
    });
    assert.equal(receipt.status, 'incomplete');
    assert.equal(JSON.stringify(receipt).includes('private-row-sentinel'), false);
    assert.equal(receipt.isolatedDirectoryRemoved, true);
  }));

test('packaged CLI verifies a synthetic copy with a bounded JSON verdict', () =>
  fixture((options) => {
    const result = spawnSync(
      process.execPath,
      [
        cli,
        '--snapshot',
        options.snapshot,
        '--snapshot-sha256',
        options.expectedSnapshotHash,
        '--migrations',
        options.migrationsDir,
        '--migrations-sha256',
        options.expectedMigrationHash,
        '--scratch',
        options.scratchParent,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.status, 'isolated_upgrade_verified');
    assert.equal(receipt.isolatedDirectoryRemoved, true);
    assert.ok(result.stdout.length < 2048);
    assert.equal(result.stdout.includes('malformed-retained-summary'), false);
  }));

test('packaged CLI refuses missing arguments without raw exception output', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'incomplete', phase: 'initialization' });
  assert.equal(result.stderr, '');
});
