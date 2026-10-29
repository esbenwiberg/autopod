import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduledJob, ScheduledScanPolicy } from '@autopod/shared';
import Database from 'better-sqlite3';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { Detector } from '../security/detectors/detector.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { type ScheduledCollectorDeps, collectScheduledScan } from './scan-collector.js';
import { createScanCoordinator } from './scan-coordinator.js';
import { createScanReportRepository } from './scan-report-repository.js';

const policy: ScheduledScanPolicy = {
  version: 1,
  scope: 'current_tree',
  baseRef: 'main',
  headRef: 'main',
  scanners: ['dependencies'],
  judgment: 'none',
};
const advisory = {
  identity: 'advisory',
  ruleId: 'CVE-fixture',
  severity: 'high' as const,
  summary: 'Retained vulnerability',
};
const auditLockfile = async () => ({
  version: 'fixture',
  evidenceHash: 'fixture-response',
  findings: [advisory],
});

// Build immutable trees directly: large fixtures need neither thousands of files
// nor thousands of Git processes, and exercise the real collector subprocesses.
function treeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'scan-review-'));
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync('git', args, {
      cwd: dir,
      input,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    }).trim();
  git(['init', '-q']);
  const blob = (content: string) => git(['hash-object', '-w', '--stdin'], content);
  const tree = (entries: Array<{ name: string; sha: string; tree?: boolean }>) =>
    git(
      ['mktree', '-z'],
      entries
        .map(
          (entry) => `${entry.tree ? '040000 tree' : '100644 blob'} ${entry.sha}\t${entry.name}\0`,
        )
        .join(''),
    );
  const head = (sha: string) => {
    const commit = git(['commit-tree', sha, '-m', 'fixture']);
    git(['update-ref', 'refs/remotes/origin/main', commit]);
    return commit;
  };
  return { dir, blob, tree, head };
}

async function roundtrip(
  f: ReturnType<typeof treeFixture>,
  deps: ScheduledCollectorDeps,
  expected: 'complete' | 'incomplete',
) {
  let db = createTestDb();
  try {
    let reports = createScanReportRepository(db);
    const coordinator = createScanCoordinator({
      reports,
      collector: deps,
      prepare: async () => ({ workdir: f.dir, repository: 'fixture', cleanup: async () => {} }),
      logger: pino({ level: 'silent' }),
    });
    const job: ScheduledJob = {
      id: 'review-job',
      name: 'review',
      scan: policy,
      templateId: 'template',
      templateName: 'review',
      profileName: null,
      task: 'review',
      fieldValues: {},
      cronExpression: '0 0 * * *',
      enabled: true,
      nextRunAt: '2026-10-29T00:00:00Z',
      lastRunAt: null,
      lastPodId: null,
      catchupPending: false,
      createdAt: '2026-10-29T00:00:00Z',
      updatedAt: '2026-10-29T00:00:00Z',
    };
    const report = await coordinator.collect(job, 'review-run');
    expect(report.status).toBe(expected);
    expect(report.collection?.baseSha).toMatch(/^[a-f0-9]{40}$/);
    expect(report.collection?.headSha).toBe(report.collection?.baseSha);
    expect(report.collection?.repository).toBe('fixture');
    expect(report.collection?.scope).toBe('current_tree');
    expect(report.collection?.findings.length).toBeGreaterThan(0);
    expect(reports.view(report.id).evidenceDiagnostics).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(report.collection))).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    expect(report.collection?.scannedPaths?.length).toBeLessThanOrEqual(10000);
    if (expected === 'incomplete') {
      expect(report.collection?.diagnostics.length).toBeGreaterThan(0);
      expect(report.collection?.scanners).toEqual([
        expect.objectContaining({ status: 'failed', findingCount: null }),
      ]);
    }
    const file = join(f.dir, 'receipt.db');
    writeFileSync(file, db.serialize());
    db.close();
    db = new Database(file);
    reports = createScanReportRepository(db);
    expect(reports.get(report.id)).toEqual(report);
    expect(reports.unresolved(report.id)).toHaveLength(report.collection?.findings.length ?? 0);
    expect(reports.unresolvedPage(report.id).diagnostics).toEqual([]);
    return report;
  } finally {
    db.close();
  }
}

describe('scheduled scan complete-review regressions', () => {
  it.each([
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'app.vbproj',
    'app.vcxproj',
    'packages.config',
    'Directory.Packages.props',
    'build.sbt',
    'mix.exs',
    'pubspec.yaml',
    'Package.swift',
    'setup.py',
    'setup.cfg',
  ])('records unsupported dependency project %s with unknown coverage', async (marker) => {
    const f = treeFixture();
    try {
      f.head(f.tree([{ name: marker, sha: f.blob('project') }]));
      const result = await collectScheduledScan(f.dir, 'fixture', policy, { auditLockfile });
      expect(result.scanners[0]).toMatchObject({ status: 'failed', findingCount: null });
      expect(result.scanners[0]?.diagnostic).toBeTruthy();
      expect(result.findings).toEqual([]);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('retains supported findings alongside unsupported projects through SQLite', async () => {
    const f = treeFixture();
    try {
      const sha = f.blob('{}');
      f.head(
        f.tree([
          { name: 'package-lock.json', sha },
          { name: 'pom.xml', sha },
        ]),
      );
      const result = await collectScheduledScan(f.dir, 'fixture', policy, { auditLockfile });
      expect(result.findings).toHaveLength(1);
      expect(result.scanners[0]).toMatchObject({ status: 'failed', findingCount: null });
      const db = createTestDb();
      try {
        const reports = createScanReportRepository(db);
        expect(reports.finish(reports.begin('job', 'mixed', policy).id, result).status).toBe(
          'incomplete',
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it.each([100, 10001])(
    'roundtrips %i real tracked paths without losing identities or partial findings',
    async (count) => {
      const f = treeFixture();
      try {
        const sha = f.blob('{}');
        f.head(
          f.tree([
            { name: '000-package', sha: f.tree([{ name: 'package-lock.json', sha }]), tree: true },
            ...Array.from({ length: count - 1 }, (_, i) => ({ name: `file-${i}`, sha })),
          ]),
        );
        await roundtrip(f, { auditLockfile }, count > 10000 ? 'incomplete' : 'complete');
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    },
  );

  it.each([400, 800, 1300])(
    'roundtrips %i escaped long paths with the actual serialized budget',
    async (count) => {
      const f = treeFixture();
      try {
        const sha = f.blob('{}');
        let subtree = f.tree(Array.from({ length: count }, (_, i) => ({ name: `file-${i}`, sha })));
        for (let i = 0; i < 6; i++) {
          subtree = f.tree([{ name: '"'.repeat(180), sha: subtree, tree: true }]);
        }
        const root = f.tree([
          { name: '000-package', sha: f.tree([{ name: 'package-lock.json', sha }]), tree: true },
          { name: 'long', sha: subtree, tree: true },
        ]);
        f.head(root);
        const paths = Array.from(
          { length: count },
          (_, i) => `long/${Array.from({ length: 6 }, () => '"'.repeat(180)).join('/')}/file-${i}`,
        );
        expect(Buffer.byteLength(paths.join('\0'))).toBeLessThan(2 * 1024 * 1024);
        if (count === 1300)
          expect(Buffer.byteLength(JSON.stringify(paths))).toBeGreaterThan(2 * 1024 * 1024);
        await roundtrip(f, { auditLockfile }, count === 1300 ? 'incomplete' : 'complete');
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    },
  );

  it('bounds serialized findings during collection and preserves every earlier accepted finding', async () => {
    const f = treeFixture();
    try {
      const sha = f.blob('{}');
      const subtree = f.tree([{ name: 'package-lock.json', sha }]);
      f.head(
        f.tree(
          Array.from({ length: 40 }, (_, i) => ({
            name: `project-${i.toString().padStart(2, '0')}`,
            sha: subtree,
            tree: true,
          })),
        ),
      );
      const audit = vi.fn(async () => ({
        ...(await auditLockfile()),
        findings: [{ ...advisory, summary: 'x'.repeat(60000) }],
      }));
      const report = await roundtrip(f, { auditLockfile: audit }, 'incomplete');
      expect(report.collection?.findings.map((finding) => finding.file)).toContain(
        'project-00/package-lock.json',
      );
      expect(report.collection?.findings.length).toBeLessThan(40);
      expect(report.collection?.findings.map((finding) => finding.file).sort()).toEqual(
        Array.from(
          { length: audit.mock.calls.length - 1 },
          (_, i) => `project-${i.toString().padStart(2, '0')}/package-lock.json`,
        ),
      );
      expect(audit.mock.calls.length).toBeLessThan(40);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('charges repeated oversized objects against the aggregate budget and retains earlier findings', async () => {
    const f = treeFixture();
    try {
      const small = f.blob('fixture');
      const oversized = f.blob('x'.repeat(2 * 1024 * 1024 + 1));
      f.head(
        f.tree([
          { name: '000-first.txt', sha: small },
          ...Array.from({ length: 18 }, (_, i) => ({
            name: `large-${i.toString().padStart(2, '0')}`,
            sha: oversized,
          })),
          { name: 'zzz-after-budget.txt', sha: small },
        ]),
      );
      const scan = vi.fn<NonNullable<Detector['scanWithBaselineIdentity']>>(async (file) => [
        {
          identity: file.path,
          finding: {
            detector: 'secrets',
            file: file.path,
            line: 1,
            severity: 'high',
            snippet: '[REDACTED]',
          },
        },
      ]);
      const trace = join(f.dir, 'git-trace');
      vi.stubEnv('GIT_TRACE', trace);
      const result = await collectScheduledScan(
        f.dir,
        'fixture',
        { ...policy, scanners: ['secrets'] },
        {
          secretVersion: async () => 'fixture',
          secrets: {
            name: 'secrets',
            warmup: async () => {},
            scan: async () => [],
            scanWithBaselineIdentity: scan,
          },
        },
      );
      expect(result.scanners[0]).toMatchObject({ status: 'failed', findingCount: null });
      expect(result.findings.map((finding) => finding.file)).toEqual(['000-first.txt']);
      expect(scan.mock.calls.map(([file]) => file.path)).toEqual(['000-first.txt']);
      expect(result.scanners[0]?.diagnostic).toMatch(/budget/i);
      const commands = readFileSync(trace, 'utf8');
      // One small blob and sixteen oversized size checks exhaust 32 MiB.
      // No oversized blob is buffered, and later paths are never read.
      expect(commands.match(/built-in: git cat-file -s /g)).toHaveLength(17);
      expect(commands.match(/built-in: git cat-file blob /g)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
