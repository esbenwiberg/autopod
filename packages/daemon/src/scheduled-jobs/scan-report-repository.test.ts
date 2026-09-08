import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  it('pages beyond 100 reports with stable ties and excludes newer insertions from continuation', () => {
    let db = createTestDb();
    const directory = mkdtempSync(join(tmpdir(), 'scan-history-page-'));
    const repo = createScanReportRepository(db);
    try {
      const ids = Array.from({ length: 121 }, (_, i) => repo.begin('job', `page-${i}`, policy).id)
        .sort()
        .reverse();
      db.prepare("UPDATE scheduled_scan_reports SET created_at = '2026-09-07T00:00:00Z'").run();
      let page = repo.page('job');
      expect(page.items).toHaveLength(20);
      expect(page.items[0]).not.toHaveProperty('collection');
      const actual = page.items.map((item) => item.id);
      repo.begin('job', 'newer-after-first-page', policy);
      const file = join(directory, 'state.db');
      writeFileSync(file, db.serialize());
      db.close();
      db = new Database(file);
      while (page.nextCursor) {
        page = createScanReportRepository(db).page('job', page.nextCursor);
        actual.push(...page.items.map((item) => item.id));
        if (actual.length > 121) throw new Error('Pagination repeated an earlier page');
      }
      expect(actual).toEqual(ids);
      const reopened = createScanReportRepository(db);
      const foreign = reopened.begin('other-job', 'foreign-cursor', policy);
      expect(() => reopened.page('job', foreign.id)).toThrow(/cursor/i);
      expect(() => reopened.page('job', 'missing')).toThrow(/cursor/i);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('projects malformed report summaries without exporting payloads or manufacturing zero findings', () => {
    const db = createTestDb();
    const repo = createScanReportRepository(db);
    try {
      const report = repo.begin('job', 'malformed-summary', policy);
      db.prepare('UPDATE scheduled_scan_reports SET collection = ?, judgment = ? WHERE id = ?').run(
        '{broken-private-payload',
        '[]',
        report.id,
      );
      const page = repo.page('job');
      expect(page.items[0]).toMatchObject({
        id: report.id,
        findingCount: null,
        judgmentStatus: null,
      });
      expect(page.items[0]?.diagnostics).toHaveLength(2);
      expect(JSON.stringify(page)).not.toContain('private-payload');
      expect(
        db.prepare('SELECT collection FROM scheduled_scan_reports WHERE id = ?').get(report.id),
      ).toEqual({ collection: '{broken-private-payload' });
    } finally {
      db.close();
    }
  });

  it('keeps 1200 unresolved findings reviewable and permits only explicitly selected IDs', () => {
    const db = createTestDb();
    const repo = createScanReportRepository(db);
    try {
      const finding = collection.findings[0];
      if (!finding) throw new Error('Missing fixture finding');
      let reportId = '';
      for (let run = 0; run < 2; run++) {
        const report = repo.begin('large-job', `large-${run}`, policy);
        reportId = report.id;
        repo.finish(report.id, {
          ...collection,
          findings: Array.from({ length: 600 }, (_, index) => ({
            ...finding,
            id: `finding-${String(run * 600 + index).padStart(4, '0')}`,
          })),
        });
      }
      const decision = repo.triage({
        reportId,
        requestKey: 'large-selection',
        findingIds: ['finding-1199'],
        action: 'select_repair',
        reason: 'Only the reviewed item',
        actor: { type: 'human', userId: 'operator' },
      });
      expect(decision.findingIds).toEqual(['finding-1199']);
      let page = repo.unresolvedPage(reportId);
      const ids = page.items.map((item) => item.id);
      while (page.nextCursor) {
        page = repo.unresolvedPage(reportId, page.nextCursor);
        ids.push(...page.items.map((item) => item.id));
        if (ids.length > 1200) throw new Error('Repeated finding page');
      }
      expect(new Set(ids).size).toBe(1200);
      expect(repo.selectedUnresolved(reportId, ['finding-1199'])).toHaveLength(1);
      const other = repo.begin('other-job', 'other-run', policy);
      repo.finish(other.id, {
        ...collection,
        findings: [{ ...finding, id: 'foreign-finding' }],
      });
      expect(() =>
        repo.triage({
          ...decision,
          requestKey: 'foreign-selection',
          findingIds: ['foreign-finding'],
        }),
      ).toThrow('not unresolved');
      expect(repo.selectedUnresolved(reportId, ['foreign-finding'])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('pages durable decisions newest first and keeps a resolved finding cursor usable', () => {
    const db = createTestDb();
    const repo = createScanReportRepository(db);
    try {
      const report = repo.begin('job', 'many-decisions', policy);
      repo.finish(report.id, collection);
      const ids = Array.from(
        { length: 1002 },
        (_, i) =>
          repo.triage({
            reportId: report.id,
            requestKey: `defer-${i}`,
            findingIds: ['stable-finding'],
            action: 'defer',
            reason: 'Recorded human decision',
            actor: { type: 'human', userId: 'operator' },
          }).id,
      );
      let page = repo.decisionPage(report.id);
      const loaded = page.items.map((item) => item.id);
      while (page.nextCursor) {
        page = repo.decisionPage(report.id, page.nextCursor);
        loaded.push(...page.items.map((item) => item.id));
        if (loaded.length > 1002) throw new Error('Repeated decision page');
      }
      expect(loaded).toEqual(ids.reverse());
      const first = loaded[0];
      if (!first) throw new Error('No decision');
      expect(repo.getDecision(report.id, first).id).toBe(first);
      const other = repo.begin('other-job', 'unrelated', policy);
      expect(() => repo.getDecision(other.id, first)).toThrow('does not belong');
      expect(() => repo.decisionPage(other.id, first)).toThrow('does not belong');
      repo.triage({
        reportId: report.id,
        requestKey: 'resolve-once',
        findingIds: ['stable-finding'],
        action: 'resolve',
        reason: 'Human reviewed resolution',
        actor: { type: 'human', userId: 'operator' },
      });
      expect(
        createScanReportRepository(db).unresolvedPage(report.id, 'stable-finding').items,
      ).toEqual([]);
      expect(repo.selectedUnresolved(report.id, ['stable-finding'])).toEqual([]);
      expect(() =>
        repo.triage({
          reportId: report.id,
          requestKey: 'stale-selection',
          findingIds: ['stable-finding'],
          action: 'select_repair',
          reason: 'Stale selection',
          actor: { type: 'human', userId: 'operator' },
        }),
      ).toThrow('not unresolved');
    } finally {
      db.close();
    }
  });

  it.each([139, 154])(
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
