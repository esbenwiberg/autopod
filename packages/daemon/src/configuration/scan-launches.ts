import type {
  EffectiveLaunchConfig,
  Pod,
  ScanTriageDecision,
  ScheduledJob,
  ScheduledScanReport,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { atomicPodChange } from '../db/unit-of-work.js';
import type { PodRepository } from '../pods/pod-repository.js';
import type { ScanReportRepository } from '../scheduled-jobs/scan-report-repository.js';
import { configurationDigest } from './configuration-digest.js';
import { configurationError } from './configuration-store.js';
import { type LaunchResolutionServices, resolveLaunch } from './launch-resolver.js';
import type { LaunchSnapshotRepository } from './launch-snapshot.js';
import { deriveScanRepair, readScanConfiguration } from './scan-repair-config.js';

/** Scans have no coding pod. Freeze their selected repair configuration separately from collected source. */
export function createScanLaunches(options: {
  db: Database.Database;
  resolution: LaunchResolutionServices;
  snapshots: LaunchSnapshotRepository;
  pods: PodRepository;
  ready(): boolean;
  create(config: EffectiveLaunchConfig, ownerUserId: string): Pod;
}) {
  function assertReady() {
    if (!options.ready())
      configurationError('Configuration cutover is incomplete', 'CONFIG_CUTOVER_REQUIRED', 409);
  }
  const read = (reportId: string) => readScanConfiguration(options.db, reportId);
  return {
    read,
    async prepare(job: ScheduledJob, reportId: string): Promise<EffectiveLaunchConfig> {
      assertReady();
      const report = options.db
        .prepare('SELECT job_id,policy FROM scheduled_scan_reports WHERE id=?')
        .get(reportId) as { job_id: string; policy: string } | undefined;
      if (
        !report ||
        report.job_id !== job.id ||
        configurationDigest(JSON.parse(report.policy)) !== configurationDigest(job.scan)
      )
        configurationError(
          'Scan report and scheduled policy differ',
          'SCAN_RECONCILIATION_REQUIRED',
          409,
        );
      const prior = read(reportId);
      if (prior) {
        await options.resolution.assertCapabilities(prior);
        return prior;
      }
      if (!job.launch || !job.ownerUserId || !job.scan || !('repositoryId' in job.launch))
        configurationError(
          'Select an enrolled repository for this scan',
          'SCAN_CONFIGURATION_UNAVAILABLE',
          409,
        );
      const config = await resolveLaunch(
        { ...job.launch, intent: 'task', task: 'Collect deterministic repository scan evidence' },
        options.resolution,
      );
      if (!config.repository)
        configurationError('A scan requires a repository', 'SCAN_CONFIGURATION_UNAVAILABLE', 409);
      assertReady();
      options.db
        .prepare(
          'INSERT OR IGNORE INTO scheduled_scan_configuration(report_id,digest,payload,created_at) VALUES(?,?,?,?)',
        )
        .run(reportId, config.digest, JSON.stringify(config), new Date().toISOString());
      const frozen = read(reportId);
      if (!frozen)
        configurationError(
          'Scan configuration was not retained',
          'CONFIG_SNAPSHOT_UNAVAILABLE',
          500,
        );
      await options.resolution.assertCapabilities(frozen);
      assertReady();
      return frozen;
    },
    async repair(input: {
      report: ScheduledScanReport;
      selectionId: string;
      task: string;
      reports: ScanReportRepository;
    }): Promise<string> {
      const existing = input.reports.getRepairPodId(input.selectionId);
      if (existing) return existing;
      assertReady();
      const source = read(input.report.id);
      if (!source?.repository)
        configurationError(
          'This report has no frozen repair configuration; collect a new report',
          'SCAN_CONFIGURATION_UNAVAILABLE',
          409,
        );
      const config = deriveScanRepair(source, input.report, input.selectionId, input.task);
      await options.resolution.assertCapabilities(config);
      assertReady();
      return atomicPodChange(options.pods, () =>
        input.reports.launchRepair(input.selectionId, (decision: ScanTriageDecision) => {
          if (decision.reportId !== input.report.id || decision.actor.type !== 'human')
            configurationError(
              'Human scan repair selection changed',
              'SCAN_RECONCILIATION_REQUIRED',
              409,
            );
          const receipt = options.snapshots.admit({
            config,
            scanRepair: { reportId: input.report.id, selectionId: input.selectionId },
            requestId: `scan-repair-${configurationDigest(input.selectionId)}`,
            requestDigest: configurationDigest({
              selectionId: input.selectionId,
              actor: decision.actor,
              config: config.digest,
            }),
            createPod: () =>
              options.create(config, decision.actor.type === 'human' ? decision.actor.userId : '')
                .id,
          });
          return receipt.podId;
        }),
      );
    },
  };
}
export type ScanLaunches = ReturnType<typeof createScanLaunches>;
