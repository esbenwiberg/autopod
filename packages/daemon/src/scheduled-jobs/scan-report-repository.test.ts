import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduledScanCollection, ScheduledScanPolicy } from '@autopod/shared';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate.js';
import { createTestDb, insertTestProfile, logger } from '../test-utils/mock-helpers.js';
import { createScanReportRepository } from './scan-report-repository.js';

const policy: ScheduledScanPolicy = {
  version: 1,
  baseRef: 'main',
  headRef: 'work',
  scanners: ['secrets'],
  judgment: 'none',
};
const collection: ScheduledScanCollection = {
  version: 1,
  repository: 'fixture-repo',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  files: [{ path: 'source.ts', change: 'modified' }],
  stacks: ['typescript'],
  scanners: [{ scanner: 'secrets', version: 'fixture-v1', status: 'completed', findingCount: 1 }],
  findings: [
    {
      id: 'stable-finding',
      scanner: 'secrets',
      ruleId: 'fixture-rule',
      file: 'source.ts',
      line: 1,
      severity: 'high',
      summary: '[REDACTED]',
    },
  ],
  diagnostics: [],
};

describe('scheduled scan reports independent of worker lifetime', () => {
  it.each([139, 145])(
    'upgrades existing schema %s while preserving legacy records and durable report recovery',
    async (version) => {
      const directory = mkdtempSync(join(tmpdir(), 'scan-upgrade-'));
      const migrations = new URL('../db/migrations', import.meta.url).pathname;
      for (const file of readdirSync(migrations))
        if (Number.parseInt(file, 10) <= version)
          copyFileSync(join(migrations, file), join(directory, file));
      let db = new Database(join(directory, 'state.db'));
      try {
        runMigrations(db, directory, logger);
        insertTestProfile(db);
        db.prepare(
          "INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id, last_validation_result) VALUES ('legacy', 'test-profile', 'Historical worker', 'complete', 'fixture', 'codex', 'legacy-branch', 'operator', '{malformed legacy json')",
        ).run();
        runMigrations(db, migrations, logger);
        let repo = createScanReportRepository(db);
        const report = repo.begin('legacy-job', 'fixed-run', policy);
        repo.finish(report.id, collection);
        const interrupted = repo.begin('legacy-job', 'interrupted-run', policy);
        db.close();
        db = new Database(join(directory, 'state.db'));
        repo = createScanReportRepository(db);
        expect(repo.recoverInterrupted()).toBe(1);
        expect(repo.get(interrupted.id).status).toBe('incomplete');
        expect(repo.get(report.id).collection).toEqual(collection);
        expect(repo.unresolved(interrupted.id)).toHaveLength(1);
        expect(
          db.prepare("SELECT last_validation_result FROM pods WHERE id = 'legacy'").get(),
        ).toEqual({ last_validation_result: '{malformed legacy json' });
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(db.pragma('foreign_key_check')).toEqual([]);
        runMigrations(db, migrations, logger);
        expect(repo.get(report.id).collection).toEqual(collection);
      } finally {
        db.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('retains one unresolved identity across changed line locations, empty delta and interrupted collection', () => {
    const db = createTestDb();
    const repo = createScanReportRepository(db);
    try {
      const first = repo.begin('job', 'run1', policy);
      expect(repo.finish(first.id, collection).status).toBe('complete');
      const second = repo.begin('job', 'run2', policy);
      repo.finish(second.id, {
        ...collection,
        findings: collection.findings.map((f) => ({ ...f, line: 10 })),
      });
      const empty = repo.begin('job', 'run3', policy);
      expect(
        repo.finish(empty.id, {
          ...collection,
          files: [],
          findings: [],
          scanners: [
            { scanner: 'secrets', version: 'fixture-v1', status: 'skipped_empty', findingCount: 0 },
          ],
        }).status,
      ).toBe('empty_delta');
      expect(repo.unresolved(empty.id)).toHaveLength(1);
      expect(repo.unresolved(empty.id)[0]?.line).toBe(10);
      const interrupted = repo.begin('job', 'run4', policy);
      repo.recoverInterrupted();
      expect(repo.get(interrupted.id).status).toBe('incomplete');
      expect(repo.unresolved(interrupted.id)).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM pods').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('never reports complete after scanner failure and rejects scope widening or rewritten results', () => {
    const db = createTestDb();
    const repo = createScanReportRepository(db);
    try {
      const first = repo.begin('job', 'run1', policy);
      const failed = {
        ...collection,
        findings: [],
        scanners: [
          {
            scanner: 'secrets' as const,
            version: null,
            status: 'unavailable' as const,
            findingCount: null,
          },
        ],
      };
      expect(repo.finish(first.id, failed).status).toBe('incomplete');
      expect(() => repo.finish(first.id, collection)).toThrow('different evidence');
      const second = repo.begin('job', 'run2', policy);
      expect(() => repo.finish(second.id, { ...collection, files: [] })).toThrow('outside');
      expect(repo.get(second.id).status).toBe('collecting');
    } finally {
      db.close();
    }
  });

  it('persists human triage across database reopen and launches a selected repair once, preserving decisions on failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-triage-'));
    let db = createTestDb();
    let repo = createScanReportRepository(db);
    try {
      insertTestProfile(db);
      const report = repo.begin('job', 'run1', policy);
      repo.finish(report.id, collection);
      const input = {
        requestKey: 'human-selection',
        reportId: report.id,
        findingIds: ['stable-finding'],
        action: 'select_repair' as const,
        actor: { type: 'human' as const, userId: 'operator' },
        reason: 'Repair this selected finding',
      };
      const selection = repo.triage(input);
      expect(repo.triage(input).id).toBe(selection.id);
      expect(() => repo.triage({ ...input, reason: 'Changed instruction' })).toThrow(
        'different decision',
      );
      expect(() =>
        repo.launchRepair(selection.id, () => {
          throw new Error('dispatch unavailable');
        }),
      ).toThrow('dispatch unavailable');
      await db.backup(join(dir, 'state.db'));
      db.close();
      db = new Database(join(dir, 'state.db'));
      repo = createScanReportRepository(db);
      expect(repo.triage(input).id).toBe(selection.id);
      const spawn = vi.fn(() => {
        db.prepare(
          `INSERT INTO pods (id, profile_name, task, status, model, runtime, branch, user_id) VALUES ('repair', 'test-profile', 'selected repair', 'queued', 'model', 'codex', 'branch', 'operator')`,
        ).run();
        return 'repair';
      });
      expect(repo.launchRepair(selection.id, spawn)).toBe('repair');
      expect(repo.launchRepair(selection.id, spawn)).toBe('repair');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(() => repo.launchRepair('no-human-selection', spawn)).toThrow('recorded human');
      expect(() => db.exec("UPDATE scheduled_scan_triage SET reason = 'rewrite'")).toThrow(
        'immutable',
      );
      expect(repo.unresolved(report.id)).toHaveLength(1); // Selection is not proof of repair.
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
