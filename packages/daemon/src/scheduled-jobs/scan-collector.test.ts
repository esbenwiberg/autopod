import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Profile, ScheduledJob, ScheduledScanPolicy } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createProviderAnthropicClient } from '../providers/llm-client.js';
import type { Detector } from '../security/detectors/detector.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { collectScheduledScan } from './scan-collector.js';
import { createScanCoordinator } from './scan-coordinator.js';
import { createBoundedScanJudge } from './scan-judge.js';
import { createScanReportRepository } from './scan-report-repository.js';

vi.mock('../providers/llm-client.js', () => ({ createProviderAnthropicClient: vi.fn() }));

const policy: ScheduledScanPolicy = {
  version: 1,
  scope: 'delta',
  baseRef: 'main',
  headRef: 'work',
  scanners: ['secrets', 'dependencies'],
  judgment: 'none',
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-delta-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'outside.ts'), 'Existing file outside the requested delta');
  writeFileSync(join(dir, 'source.ts'), 'Before');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('update-ref', 'refs/remotes/origin/work', 'HEAD');
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'head',
    );
    git('update-ref', 'refs/remotes/origin/work', 'HEAD');
  };
  return { dir, git, commit };
}

describe('current-tree scheduled security checks', () => {
  it('checks existing secrets and unchanged dependencies for manual and scheduled runs', async () => {
    const f = fixture();
    const db = createTestDb();
    const reports = createScanReportRepository(db);
    const currentPolicy = { ...policy, scope: undefined };
    const audit = vi.fn(async () => ({
      version: 'audit-fixture',
      evidenceHash: 'immutable-advisory-response',
      findings: [
        {
          identity: 'old-advisory',
          ruleId: 'CVE-fixture',
          severity: 'high' as const,
          summary: 'Current vulnerability',
        },
      ],
    }));
    const coordinator = createScanCoordinator({
      reports,
      collector: {
        auditLockfile: audit,
        secretVersion: async () => 'fixture',
        secrets: {
          name: 'secrets',
          warmup: async () => {},
          scan: async () => [],
          scanWithBaselineIdentity: async (file) =>
            file.content.includes('AKIA')
              ? [
                  {
                    identity: 'existing-secret',
                    finding: {
                      detector: 'secrets',
                      file: file.path,
                      line: 1,
                      ruleId: 'fixture-secret',
                      severity: 'high',
                      snippet: '[REDACTED]',
                    },
                  },
                ]
              : [],
        },
      },
      prepare: async () => ({ workdir: f.dir, repository: 'fixture', cleanup: async () => {} }),
      logger: pino({ level: 'silent' }),
    });
    try {
      writeFileSync(join(f.dir, 'source.ts'), `const key = "${'AKIA'}${'A'.repeat(16)}";`);
      writeFileSync(join(f.dir, 'package.json'), '{}');
      writeFileSync(join(f.dir, 'package-lock.json'), '{"lockfileVersion":3}');
      f.commit();
      f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const job = { id: 'current-job', scan: currentPolicy } as ScheduledJob;
      for (const key of ['manual:current', 'scheduled:current:time']) {
        const report = await coordinator.collect(job, key);
        expect(report.status).toBe('complete');
        expect(report.collection?.files).toEqual([]);
        expect(report.collection?.scanners.map((scanner) => scanner.status)).toEqual([
          'completed',
          'completed',
        ]);
        expect(report.collection?.findings.map((finding) => finding.scanner).sort()).toEqual([
          'dependencies',
          'secrets',
        ]);
        expect(JSON.stringify(report.collection)).not.toContain('A'.repeat(16));
        expect(reports.get(report.id).collection?.scope).toBe('current_tree');
      }
      writeFileSync(join(f.dir, 'outside.ts'), 'Unrelated change');
      f.commit();
      const report = await coordinator.collect(job, 'manual:unrelated');
      expect(report.status).toBe('complete');
      expect(report.collection?.files).toEqual([{ path: 'outside.ts', change: 'modified' }]);
      expect(report.collection?.findings).toHaveLength(2);
      expect(reports.unresolved(report.id)).toHaveLength(2);
      expect(audit).toHaveBeenCalledTimes(3);
      expect(db.prepare('SELECT count(*) AS n FROM pods').get()).toEqual({ n: 0 });
    } finally {
      db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('distinguishes successful zero findings, missing capability, failures and unsupported manifests', async () => {
    const f = fixture();
    const db = createTestDb();
    const reports = createScanReportRepository(db);
    const currentPolicy = { ...policy, scope: undefined };
    const detector: Detector = {
      name: 'secrets',
      warmup: async () => {},
      scan: async () => [],
      scanWithBaselineIdentity: async () => [],
    };
    const audit = vi.fn(async () => ({
      version: 'fixture',
      evidenceHash: 'evidence',
      findings: [],
    }));
    const deps = { secrets: detector, secretVersion: async () => 'fixture', auditLockfile: audit };
    const collect = () => collectScheduledScan(f.dir, 'fixture', currentPolicy, deps);
    const finish = async () => {
      const report = reports.begin('job', Math.random().toString(), currentPolicy);
      return reports.finish(report.id, await collect());
    };
    try {
      writeFileSync(join(f.dir, 'package-lock.json'), '{}');
      f.commit();
      f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      expect(await finish()).toMatchObject({ status: 'complete', collection: { findings: [] } });
      const missing = await collectScheduledScan(f.dir, 'fixture', currentPolicy, {
        secrets: detector,
        secretVersion: deps.secretVersion,
      });
      expect(missing.scanners[1]).toMatchObject({ status: 'unavailable', findingCount: null });
      audit.mockRejectedValueOnce(new Error('Registry down'));
      expect((await finish()).status).toBe('incomplete');
      detector.scanWithBaselineIdentity = async () => null;
      expect((await finish()).status).toBe('incomplete');
      detector.scanWithBaselineIdentity = async () => [];
      writeFileSync(join(f.dir, 'pyproject.toml'), '[project]');
      f.commit();
      expect((await finish()).status).toBe('incomplete');
    } finally {
      db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('retains useful findings while unsupported content makes coverage incomplete', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, 'a-binary'), Buffer.from([0, 1, 2]));
      writeFileSync(join(f.dir, 'source.ts'), `const key = "${'AKIA'}${'A'.repeat(16)}";`);
      writeFileSync(join(f.dir, 'Cargo.toml'), '[package]');
      writeFileSync(join(f.dir, 'package-lock.json'), '{}');
      f.commit();
      f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const result = await collectScheduledScan(
        f.dir,
        'fixture',
        { ...policy, scope: undefined },
        {
          auditLockfile: async () => ({
            version: 'fixture',
            evidenceHash: 'evidence',
            findings: [
              {
                identity: 'advisory',
                ruleId: 'CVE-fixture',
                severity: 'high',
                summary: 'Current vulnerability',
              },
            ],
          }),
        },
      );
      expect(result.scanners.map((scanner) => scanner.status)).toEqual(['failed', 'failed']);
      expect(result.findings.map((finding) => finding.scanner).sort()).toEqual([
        'dependencies',
        'secrets',
      ]);
      expect(result.scanners.every((scanner) => scanner.findingCount === null)).toBe(true);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('reports oversized tracked content and finding limits as incomplete', async () => {
    const f = fixture();
    const detector: Detector = {
      name: 'secrets',
      warmup: async () => {},
      scan: async () => [],
      scanWithBaselineIdentity: async () => [],
    };
    const currentPolicy = {
      ...policy,
      scope: undefined,
      scanners: ['secrets'] as ScheduledScanPolicy['scanners'],
    };
    try {
      writeFileSync(join(f.dir, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
      f.commit();
      f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      const result = await collectScheduledScan(f.dir, 'fixture', currentPolicy, {
        secrets: detector,
        secretVersion: async () => 'fixture',
      });
      expect(result.scanners[0]).toMatchObject({ status: 'failed', findingCount: null });
      rmSync(join(f.dir, 'large.txt'));
      f.commit();
      detector.scanWithBaselineIdentity = async () =>
        Array.from({ length: 1001 }, (_, i) => ({
          identity: String(i),
          finding: {
            detector: 'secrets',
            file: 'outside.ts',
            line: i + 1,
            ruleId: 'fixture',
            severity: 'high',
            snippet: '[REDACTED]',
          },
        }));
      const limited = await collectScheduledScan(f.dir, 'fixture', currentPolicy, {
        secrets: detector,
        secretVersion: async () => 'fixture',
      });
      expect(limited.scanners[0]).toMatchObject({ status: 'failed', findingCount: null });
      expect(limited.findings).toHaveLength(1000);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});

describe('exact deterministic scheduled delta collector', () => {
  it('freezes a strict time window, keeps an old branch empty, and rejects timestamps that would widen its delta', async () => {
    const f = fixture();
    const timedCommit = (date: string) => {
      f.git('add', '.');
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'timed fixture',
        ],
        { cwd: f.dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
      );
      f.git('update-ref', 'refs/remotes/origin/work', 'HEAD');
    };
    const window = {
      ...policy,
      baseRef: 'work',
      headRef: 'work',
      scanners: ['dependencies'] as const,
      windowHours: 24,
    };
    try {
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--amend',
          '--no-edit',
          '--date=2020-01-01T00:00:00Z',
        ],
        { cwd: f.dir, env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } },
      );
      f.git('update-ref', 'refs/remotes/origin/work', 'HEAD');
      const rootWindow = await collectScheduledScan(
        f.dir,
        'fixture',
        { ...window, scanners: [...window.scanners] },
        {},
        '2020-01-01T01:00:00Z',
      );
      expect(rootWindow.baseKind).toBe('empty_tree');
      expect(rootWindow.window?.selectedCommits).toHaveLength(1);
      expect(rootWindow.files).toEqual([
        { path: 'outside.ts', change: 'added' },
        { path: 'source.ts', change: 'added' },
      ]);
      const empty = await collectScheduledScan(
        f.dir,
        'fixture',
        { ...window, scanners: [...window.scanners] },
        {},
        '2026-09-07T10:00:00Z',
      );
      expect(empty.files).toEqual([]);
      expect(empty.window).toMatchObject({
        start: '2026-09-06T10:00:00.000Z',
        end: '2026-09-07T10:00:00.000Z',
        selectedCommits: [],
      });
      expect(empty.baseSha).toBe(empty.headSha);
      writeFileSync(join(f.dir, 'recent.ts'), 'Selected recent source');
      timedCommit('2026-09-07T09:00:00Z');
      const recent = await collectScheduledScan(
        f.dir,
        'fixture',
        { ...window, scanners: [...window.scanners] },
        {},
        '2026-09-07T10:00:00Z',
      );
      expect(recent.files).toEqual([{ path: 'recent.ts', change: 'added' }]);
      expect(recent.window?.selectedCommits).toHaveLength(1);
      writeFileSync(join(f.dir, 'out-of-window.ts'), 'Timestamp outside window');
      timedCommit('2020-01-02T00:00:00Z');
      const interleaved = await collectScheduledScan(
        f.dir,
        'fixture',
        { ...window, scanners: [...window.scanners] },
        {},
        '2026-09-07T10:00:00Z',
      );
      expect(interleaved.diagnostics).toHaveLength(1);
      expect(interleaved.files).toEqual([]);
      expect(interleaved.scanners).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it('persists unavailable judgment response usage through coordinator completion and disk reopen', async () => {
    const f = fixture();
    let db = createTestDb();
    const reports = createScanReportRepository(db);
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Unfinished judgment output' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 25, output_tokens: 7 },
    });
    vi.mocked(createProviderAnthropicClient).mockResolvedValue({
      ok: true,
      model: 'bound-model',
      client: { messages: { create } },
    } as never);
    const judge = createBoundedScanJudge(
      {
        name: 'fixture',
        modelProvider: 'max',
        defaultModel: 'bound-model',
        providerCredentials: { provider: 'max', oauthToken: 'synthetic-fixture' },
      } as Profile,
      {},
      pino({ level: 'silent' }),
    );
    const coordinator = createScanCoordinator({
      reports,
      prepare: async () => ({
        workdir: f.dir,
        repository: 'fixture',
        judge,
        cleanup: async () => {},
      }),
      logger: pino({ level: 'silent' }),
    });
    try {
      writeFileSync(join(f.dir, 'source.ts'), 'Changed source for bounded judgment');
      f.commit();
      const report = await coordinator.collect(
        {
          id: 'job',
          scan: { ...policy, scanners: ['dependencies'], judgment: 'bounded' },
        } as ScheduledJob,
        'usage-run',
      );
      expect(report.judgment).toMatchObject({
        status: 'unavailable',
        usage: {
          inputTokens: 25,
          outputTokens: 7,
          costUsd: null,
          provider: 'max',
          model: 'bound-model',
        },
      });
      expect(report.judgment.text).not.toContain('Unfinished judgment output');
      const file = join(f.dir, 'receipt.db');
      writeFileSync(file, db.serialize());
      db.close();
      db = new Database(file);
      expect(createScanReportRepository(db).get(report.id).judgment).toEqual(report.judgment);
      expect(create).toHaveBeenCalledOnce();
      expect(db.prepare('SELECT count(*) AS n FROM pods').get()).toEqual({ n: 0 });
    } finally {
      db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('persists the real Git report before judgment, deduplicates collection, and keeps interrupted judgment terminal', async () => {
    const f = fixture();
    const db = createTestDb();
    const reports = createScanReportRepository(db);
    let finishJudgment!: (value: { status: 'complete'; text: string }) => void;
    const judging = new Promise<{ status: 'complete'; text: string }>((resolve) => {
      finishJudgment = resolve;
    });
    const judge = vi.fn(() => judging);
    const cleanup = vi.fn(async () => {});
    const prepare = vi.fn(async () => ({ workdir: f.dir, repository: 'fixture', judge, cleanup }));
    const job = {
      id: 'job',
      scan: { ...policy, scanners: ['dependencies'], judgment: 'bounded' },
    } as ScheduledJob;
    const coordinator = createScanCoordinator({
      reports,
      prepare,
      logger: pino({ level: 'silent' }),
    });
    try {
      writeFileSync(join(f.dir, 'source.ts'), 'Harmless changed source');
      f.commit();
      const first = coordinator.collect(job, 'scheduled:job:fixed-time');
      const duplicate = coordinator.collect(job, 'scheduled:job:fixed-time');
      expect(duplicate).toBe(first);
      await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(1));
      const durable = reports.list('job')[0];
      expect(durable).toMatchObject({ status: 'complete', judgment: { status: 'pending' } });
      expect(durable?.collection?.files).toEqual([{ path: 'source.ts', change: 'modified' }]);
      expect(cleanup).toHaveBeenCalledTimes(1);
      reports.recoverInterrupted(); // Simulate restart after collection committed, before judgment settled.
      finishJudgment({ status: 'complete', text: 'Late old-process judgment' });
      expect((await first).judgment.status).toBe('unavailable');
      const restarted = createScanCoordinator({
        reports,
        prepare,
        logger: pino({ level: 'silent' }),
      });
      expect((await restarted.collect(job, 'scheduled:job:fixed-time')).id).toBe(durable?.id);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(db.prepare('SELECT count(*) AS n FROM pods').get()).toEqual({ n: 0 });
    } finally {
      db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('skips bounded judgment for an actual empty delta and retains incomplete preparation failures', async () => {
    const f = fixture();
    const db = createTestDb();
    const reports = createScanReportRepository(db);
    const judge = vi.fn();
    const prepare = vi.fn(async () => ({
      workdir: f.dir,
      repository: 'fixture',
      judge,
      cleanup: async () => {},
    }));
    const job = { id: 'empty-job', scan: { ...policy, judgment: 'bounded' } } as ScheduledJob;
    try {
      const coordinator = createScanCoordinator({
        reports,
        prepare,
        logger: pino({ level: 'silent' }),
      });
      const empty = await coordinator.collect(job, 'empty-run');
      expect(empty).toMatchObject({ status: 'empty_delta', judgment: { status: 'skipped_empty' } });
      expect(judge).not.toHaveBeenCalled();
      prepare.mockRejectedValueOnce(new Error('Fresh remote fetch failed'));
      const failed = await coordinator.collect(job, 'failed-run');
      expect(failed).toMatchObject({ status: 'incomplete', judgment: { status: 'unavailable' } });
      expect(failed.collection?.scanners).toEqual([]);
      expect(judge).not.toHaveBeenCalled();
    } finally {
      db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it('does not run scanners or widen an empty delta; missing refs remain incomplete inputs', async () => {
    const f = fixture();
    const audit = vi.fn();
    const version = vi.fn();
    try {
      const result = await collectScheduledScan(f.dir, 'fixture', policy, {
        auditLockfile: audit,
        secretVersion: version,
      });
      expect(result.files).toEqual([]);
      expect(result.scanners.map((s) => s.status)).toEqual(['skipped_empty', 'skipped_empty']);
      expect(audit).not.toHaveBeenCalled();
      expect(version).not.toHaveBeenCalled();
      const missing = await collectScheduledScan(f.dir, 'fixture', {
        ...policy,
        baseRef: 'absent',
      });
      expect(missing.diagnostics).toHaveLength(1);
      expect(missing.files).toEqual([]);
      expect(missing.scanners).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('reads only changed Git blobs, preserves stable redacted IDs, and reports unsupported dependencies as incomplete', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, 'source.ts'), `const key = "${'AKIA'}${'A'.repeat(16)}";`);
      writeFileSync(join(f.dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
      f.commit();
      const result = await collectScheduledScan(f.dir, 'fixture', policy, {
        auditLockfile: vi.fn(),
      });
      expect(result.files.map((file) => file.path).sort()).toEqual(['pnpm-lock.yaml', 'source.ts']);
      expect(result.scanners.find((s) => s.scanner === 'secrets')?.status).toBe('completed');
      expect(result.scanners.find((s) => s.scanner === 'dependencies')?.status).toBe('failed');
      expect(result.scanners.find((s) => s.scanner === 'dependencies')?.findingCount).toBeNull();
      expect(result.findings.some((finding) => finding.scanner === 'secrets')).toBe(true);
      expect(JSON.stringify(result.findings)).not.toContain('A'.repeat(16));
      const repeated = await collectScheduledScan(f.dir, 'fixture', {
        ...policy,
        scanners: ['secrets'],
      });
      expect(repeated.findings.map((finding) => finding.id)).toEqual(
        result.findings.map((finding) => finding.id),
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('does not disguise a detector exception/null result as zero findings', async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.dir, 'source.ts'), 'After');
      f.commit();
      const detector: Detector = {
        name: 'secrets',
        warmup: async () => {},
        scan: async () => [],
        scanWithBaselineIdentity: async () => null,
      };
      const result = await collectScheduledScan(
        f.dir,
        'fixture',
        { ...policy, scanners: ['secrets'] },
        { secrets: detector, secretVersion: async () => 'fixture' },
      );
      expect(result.scanners[0]).toMatchObject({ status: 'failed', findingCount: null });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
