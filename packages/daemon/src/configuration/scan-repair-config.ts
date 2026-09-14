import {
  type EffectiveLaunchConfig,
  type ScheduledScanReport,
  launchWorkSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationDigest } from './configuration-digest.js';
import { configurationError } from './configuration-store.js';

export function readScanConfiguration(
  db: Database.Database,
  reportId: string,
): EffectiveLaunchConfig | null {
  const row = db
    .prepare('SELECT digest,payload FROM scheduled_scan_configuration WHERE report_id=?')
    .get(reportId) as { digest: string; payload: string } | undefined;
  if (!row) return null;
  const config = JSON.parse(row.payload) as EffectiveLaunchConfig;
  const { digest, ...body } = config;
  if (digest !== row.digest || configurationDigest(body) !== digest)
    configurationError('Scan configuration is corrupt', 'CONFIG_SNAPSHOT_UNAVAILABLE', 409);
  return config;
}

/** Only task context and human approval mode may differ from the collected repair template. */
export function deriveScanRepair(
  source: EffectiveLaunchConfig,
  report: ScheduledScanReport,
  selectionId: string,
  task: string,
): EffectiveLaunchConfig {
  if (!source.repository || !report.collection)
    configurationError('Scan source is unavailable', 'SCAN_CONFIGURATION_UNAVAILABLE', 409);
  const remote = new URL(source.repository.config.remote);
  remote.username = '';
  remote.password = '';
  remote.search = '';
  remote.hash = '';
  if (remote.toString() !== report.collection.repository)
    configurationError(
      'Scan evidence and repository identity differ',
      'SCAN_RECONCILIATION_REQUIRED',
      409,
    );
  const base = source.worker ?? source;
  const { digest: _, ...body } = structuredClone(base);
  const selected = {
    ...body,
    task,
    intent: 'task' as const,
    worker: null,
    work: launchWorkSchema.parse({ baseBranch: report.policy.headRef }),
    workflow: {
      ...base.workflow,
      agentMode: 'auto' as const,
      promotable: false,
      completion: 'approval' as const,
    },
    origin: {
      kind: 'schedule' as const,
      jobId: report.jobId,
      runKey: `scan-repair:${selectionId}`,
    },
  };
  return { ...selected, digest: configurationDigest(selected) };
}
