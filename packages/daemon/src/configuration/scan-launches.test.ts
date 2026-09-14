import type { EffectiveLaunchConfig, ScheduledJob, ScheduledScanPolicy } from '@autopod/shared';
import { expect, it, vi } from 'vitest';
import { createPodRepository } from '../pods/pod-repository.js';
import { createScanOperatorService } from '../scheduled-jobs/scan-operator-service.js';
import { createScanReportRepository } from '../scheduled-jobs/scan-report-repository.js';
import {
  createTestConfiguration,
  insertConfigurationTestPod,
} from '../test-utils/configuration-helpers.js';
import { createTestDb } from '../test-utils/mock-helpers.js';
import { configurationDigest } from './configuration-digest.js';
import { createLaunchSnapshotRepository } from './launch-snapshot.js';
import { createScanLaunches } from './scan-launches.js';
import { deriveScanRepair } from './scan-repair-config.js';

const policy: ScheduledScanPolicy = {
  version: 1,
  baseRef: 'main',
  headRef: 'main',
  scanners: ['secrets'],
  judgment: 'none',
};
function fixture() {
  const db = createTestDb();
  const { store, services } = createTestConfiguration(db);
  const reports = createScanReportRepository(db);
  const report = reports.begin('job', 'scan-run', policy);
  const pods = createPodRepository(db);
  const snapshots = createLaunchSnapshotRepository(db, store);
  const queued: string[] = [];
  const create = vi.fn((config: EffectiveLaunchConfig, owner: string) => {
    const id = 'scan-repair-pod';
    insertConfigurationTestPod(db, id);
    db.prepare('UPDATE pods SET task=?,user_id=? WHERE id=?').run(config.task, owner, id);
    pods.afterCommit?.(() => queued.push(id));
    return pods.getOrThrow(id);
  });
  let ready = true;
  const launches = createScanLaunches({
    db,
    resolution: services,
    pods,
    snapshots,
    ready: () => ready,
    create,
  });
  const job = {
    id: 'job',
    ownerUserId: 'operator',
    launch: { repositoryId: 'repo-a' },
    scan: policy,
  } as ScheduledJob;
  const operator = createScanOperatorService({
    reports,
    jobs: {} as never,
    profiles: {} as never,
    pods: {} as never,
    configuration: launches,
  });
  function finish(repository: string) {
    return reports.finish(report.id, {
      version: 1,
      repository,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      files: [{ path: 'source.ts', change: 'modified' }],
      stacks: [],
      scanners: [{ scanner: 'secrets', version: 'fixture', status: 'completed', findingCount: 1 }],
      findings: [
        {
          id: 'finding',
          scanner: 'secrets',
          ruleId: 'fixture',
          file: 'source.ts',
          severity: 'high',
          summary: 'Fixture evidence',
        },
      ],
      diagnostics: [],
    });
  }
  return {
    db,
    store,
    services,
    reports,
    report,
    snapshots,
    queued,
    create,
    launches,
    job,
    operator,
    finish,
    pause: () => {
      ready = false;
    },
  };
}

it('freezes scan repair choices and retries the same human selection without rereading legacy profiles', async () => {
  const f = fixture();
  try {
    const frozen = await f.launches.prepare(f.job, f.report.id);
    const env = f.store.get('environment', 'env');
    f.store.write({
      id: env.id,
      kind: env.kind,
      name: env.name,
      expectedRevision: env.revision,
      payload: { ...env.payload, template: 'node24' },
    });
    expect(await f.launches.prepare(f.job, f.report.id)).toEqual(frozen);
    f.finish(new URL(frozen.repository?.config.remote ?? '').toString());
    const decision = f.reports.triage({
      reportId: f.report.id,
      requestKey: 'selection',
      action: 'select_repair',
      findingIds: ['finding'],
      reason: 'Repair this finding',
      actor: { type: 'human', userId: 'operator' },
    });
    const result = await f.operator.launch(f.report.id, decision.id);
    expect(f.snapshots.get(result.podId)).toMatchObject({
      environment: { template: 'node22' },
      workflow: { completion: 'approval', agentMode: 'auto' },
      origin: { kind: 'schedule', jobId: 'job' },
    });
    expect(f.queued).toEqual([result.podId]);
    f.pause();
    vi.mocked(f.services.assertCapabilities).mockRejectedValue(new Error('Revoked route'));
    expect(await f.operator.launch(f.report.id, decision.id)).toEqual(result);
    expect(f.create).toHaveBeenCalledOnce();
  } finally {
    f.db.close();
  }
});

it('rolls pod, snapshot and queue publication back when the repair receipt fails', async () => {
  const f = fixture();
  try {
    const config = await f.launches.prepare(f.job, f.report.id);
    f.finish(new URL(config.repository?.config.remote ?? '').toString());
    const decision = f.reports.triage({
      reportId: f.report.id,
      requestKey: 'selection',
      action: 'select_repair',
      findingIds: ['finding'],
      reason: 'Repair',
      actor: { type: 'human', userId: 'operator' },
    });
    f.db.exec(
      "CREATE TRIGGER fixture_dispatch_failure BEFORE INSERT ON scheduled_scan_repairs BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;",
    );
    await expect(f.operator.launch(f.report.id, decision.id)).rejects.toThrow('receipt failure');
    expect(f.queued).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM pods').get()).toEqual({ n: 0 });
    expect(f.snapshots.get('scan-repair-pod')).toBeNull();
    f.db.exec('DROP TRIGGER fixture_dispatch_failure');
    expect((await f.operator.launch(f.report.id, decision.id)).podId).toBe('scan-repair-pod');
  } finally {
    f.db.close();
  }
});

it('requires a new collection when an old report lacks frozen configuration', async () => {
  const f = fixture();
  try {
    f.finish('https://github.com/org/repo-a');
    const decision = f.reports.triage({
      reportId: f.report.id,
      requestKey: 'selection',
      action: 'select_repair',
      findingIds: ['finding'],
      reason: 'Repair',
      actor: { type: 'human', userId: 'operator' },
    });
    await expect(f.operator.launch(f.report.id, decision.id)).rejects.toThrow(
      'collect a new report',
    );
    expect(f.create).not.toHaveBeenCalled();
  } finally {
    f.db.close();
  }
});

it('rejects another job or changed policy before freezing a scan configuration', async () => {
  const f = fixture();
  try {
    await expect(f.launches.prepare({ ...f.job, id: 'another-job' }, f.report.id)).rejects.toThrow(
      'differ',
    );
    await expect(
      f.launches.prepare({ ...f.job, scan: { ...policy, headRef: 'another-branch' } }, f.report.id),
    ).rejects.toThrow('differ');
    expect(f.launches.read(f.report.id)).toBeNull();
  } finally {
    f.db.close();
  }
});

it('rejects forged permissions in a repair even when its digest is recomputed', async () => {
  const f = fixture();
  try {
    const frozen = await f.launches.prepare(f.job, f.report.id);
    const report = f.finish(new URL(frozen.repository?.config.remote ?? '').toString());
    const decision = f.reports.triage({
      reportId: report.id,
      requestKey: 'selection',
      action: 'select_repair',
      findingIds: ['finding'],
      reason: 'Repair',
      actor: { type: 'human', userId: 'operator' },
    });
    const { digest: _, ...body } = deriveScanRepair(frozen, report, decision.id, 'Repair');
    body.workflow.completion = 'merge';
    expect(() =>
      f.snapshots.admit({
        config: { ...body, digest: configurationDigest(body) },
        scanRepair: { reportId: report.id, selectionId: decision.id },
        requestDigest: 'forged',
        createPod: () => 'forged-pod',
      }),
    ).toThrow('widened');
    expect(f.db.prepare('SELECT count(*) AS n FROM pods').get()).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});
