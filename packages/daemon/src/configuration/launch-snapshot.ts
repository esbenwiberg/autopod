import type { EffectiveLaunchConfig } from '@autopod/shared';
import type Database from 'better-sqlite3';
import { createScanReportRepository } from '../scheduled-jobs/scan-report-repository.js';
import { type ConfigurationStore, configurationError } from './configuration-store.js';
import { deriveLaunch } from './derive-launch.js';
import { configurationDigest } from './launch-resolver.js';
import { deriveScanRepair, readScanConfiguration } from './scan-repair-config.js';

export interface LaunchSnapshotRepository {
  get(podId: string): EffectiveLaunchConfig | null;
  getOriginal(podId: string): EffectiveLaunchConfig | null;
  getPendingWorker(podId: string): EffectiveLaunchConfig | null;
  activateGoalRework(input: {
    config: EffectiveLaunchConfig;
    expectedGeneration: number;
    apply: () => void;
  }): void;
  prepareWorker(input: {
    config: EffectiveLaunchConfig;
    expectedGeneration: number;
    apply: () => void;
  }): void;
  activateWorker(
    podId: string,
    expectedGeneration: number,
    apply: (config: EffectiveLaunchConfig) => void,
  ): boolean;
  findRequest(requestId: string, requestDigest: string): string | null;
  admit(input: {
    config: EffectiveLaunchConfig;
    scanRepair?: { reportId: string; selectionId: string };
    requestId?: string;
    requestDigest: string;
    // Must synchronously insert the pod and initial attempt on this same DB connection.
    createPod: () => string;
  }): { podId: string; created: boolean };
}
/** Snapshot and pod creation share one transaction; enqueue only after admit returns. */
export function createLaunchSnapshotRepository(
  db: Database.Database,
  store: ConfigurationStore,
): LaunchSnapshotRepository {
  function findRequest(requestId: string, requestDigest: string): string | null {
    const previous = db
      .prepare('SELECT pod_id,request_digest FROM retained_pod_launch_snapshots WHERE request_id=?')
      .get(requestId) as { pod_id: string; request_digest: string } | undefined;
    if (!previous) return null;
    if (previous.request_digest !== requestDigest)
      configurationError(
        'Launch request ID was reused with a different payload',
        'REQUEST_CONFLICT',
        409,
      );
    return previous.pod_id;
  }
  function read(podId: string, original = false): EffectiveLaunchConfig | null {
    const row = db
      .prepare(
        'SELECT s.digest,s.payload,p.launch_config_digest FROM retained_pods p LEFT JOIN retained_pod_launch_snapshots s ON s.pod_id=p.id WHERE p.id=?',
      )
      .get(podId) as
      | { digest: string | null; payload: string | null; launch_config_digest: string | null }
      | undefined;
    if (!row || (!row.digest && !row.launch_config_digest)) return null;
    if (!row.payload || !row.launch_config_digest)
      configurationError(
        'Launch snapshot integrity check failed: identity is missing or inconsistent',
        'SNAPSHOT_CORRUPT',
        500,
      );
    const result = JSON.parse(row.payload) as EffectiveLaunchConfig;
    const { digest, ...body } = result;
    if (digest !== row.digest || digest !== configurationDigest(body))
      configurationError('Launch snapshot integrity check failed', 'SNAPSHOT_CORRUPT', 500);
    if (original || row.digest === row.launch_config_digest) return result;
    const phases = db
      .prepare('SELECT digest,parent_digest,payload FROM pod_launch_phases WHERE pod_id=?')
      .all(podId) as Array<{ digest: string; parent_digest: string; payload: string }>;
    let current = result;
    const visited = new Set([current.digest]);
    // Worker promotion is a bounded continuation of the original admitted template.
    for (let hop = 0; hop < 32; hop++) {
      const next = phases.filter((phase) => phase.parent_digest === current.digest);
      if (next.length !== 1 || !next[0]) break;
      const phase = next[0];
      const config = JSON.parse(phase.payload) as EffectiveLaunchConfig;
      if (
        visited.has(phase.digest) ||
        !config.derivation ||
        !['worker', 'goal-rework'].includes(config.derivation.kind) ||
        config.derivation.podId !== podId
      )
        configurationError('Launch phase chain is invalid', 'SNAPSHOT_CORRUPT', 500);
      const derived = deriveLaunch(current, {
        source: config.derivation,
        task: config.task,
        work: config.work,
        ...(config.derivation.kind === 'worker' ? { output: config.workflow.output } : {}),
      });
      if (
        derived.digest !== phase.digest ||
        configurationDigest(config) !== configurationDigest(derived)
      )
        configurationError('Launch phase integrity check failed', 'SNAPSHOT_CORRUPT', 500);
      current = config;
      visited.add(current.digest);
      if (current.digest === row.launch_config_digest) return current;
    }
    configurationError('Active launch phase is missing', 'SNAPSHOT_CORRUPT', 500);
  }
  function nextWorker(podId: string, parent: EffectiveLaunchConfig): EffectiveLaunchConfig | null {
    const rows = db
      .prepare('SELECT payload FROM pod_launch_phases WHERE pod_id=? AND parent_digest=?')
      .all(podId, parent.digest) as Array<{ payload: string }>;
    if (!rows.length) return null;
    if (rows.length !== 1 || !rows[0])
      configurationError('Worker handoff is ambiguous', 'SNAPSHOT_CORRUPT', 500);
    const config = JSON.parse(rows[0].payload) as EffectiveLaunchConfig;
    if (
      !config.derivation ||
      config.derivation.kind !== 'worker' ||
      config.derivation.podId !== podId
    )
      configurationError('Worker handoff source is invalid', 'SNAPSHOT_CORRUPT', 500);
    const expected = deriveLaunch(parent, {
      source: config.derivation,
      task: config.task,
      work: config.work,
      output: config.workflow.output,
    });
    if (configurationDigest(config) !== configurationDigest(expected))
      configurationError('Worker handoff integrity check failed', 'SNAPSHOT_CORRUPT', 500);
    return config;
  }
  return {
    activateGoalRework(input) {
      db.transaction(() => {
        const source = input.config.derivation;
        if (source?.kind !== 'goal-rework')
          configurationError('Invalid Goal rework phase', 'CONFIG_DERIVATION_INVALID');
        const parent = read(source.podId);
        if (!parent) configurationError('Goal source is unavailable', 'CONFIG_SOURCE_MISSING', 409);
        const expected = deriveLaunch(parent, {
          source,
          task: input.config.task,
          work: input.config.work,
        });
        if (configurationDigest(expected) !== configurationDigest(input.config))
          configurationError('Goal rework changed frozen authority', 'CONFIG_DERIVATION_INVALID');
        const owner = db
          .prepare(`SELECT 1 FROM pods p JOIN pod_goals g ON g.pod_id=p.id
          WHERE p.id=? AND p.launch_config_digest=? AND p.lifecycle_generation=?
          AND p.status IN ('validating','validated','failed','review_required','awaiting_input')
          AND g.state='achieved' AND g.execution_stopped=1 AND g.control_intent IS NULL
          AND NOT EXISTS (SELECT 1 FROM task_agent_runs r WHERE r.pod_id=p.id AND r.ended_at IS NULL)`)
          .get(source.podId, parent.digest, input.expectedGeneration);
        if (!owner)
          configurationError(
            'Goal must be achieved and its execution stopped before Task rework',
            'GOAL_REWORK_UNAVAILABLE',
            409,
          );
        if (
          db
            .prepare('SELECT 1 FROM pod_launch_phases WHERE pod_id=? AND parent_digest=?')
            .get(source.podId, parent.digest)
        )
          configurationError('Goal already has a continuation phase', 'CONFIG_SOURCE_CHANGED', 409);
        db.prepare(
          'INSERT INTO pod_launch_phases(pod_id,digest,parent_digest,payload,created_at) VALUES(?,?,?,?,?)',
        ).run(
          source.podId,
          expected.digest,
          parent.digest,
          JSON.stringify(expected),
          new Date().toISOString(),
        );
        db.prepare('UPDATE pods SET launch_config_digest=? WHERE id=?').run(
          expected.digest,
          source.podId,
        );
        input.apply();
      })();
    },
    findRequest,
    get: (podId) => read(podId),
    getOriginal: (podId) => read(podId, true),
    getPendingWorker(podId) {
      const parent = read(podId);
      return parent ? nextWorker(podId, parent) : null;
    },
    prepareWorker(input) {
      db.transaction(() => {
        const source = input.config.derivation;
        if (!source || source.kind !== 'worker')
          configurationError('Worker handoff source is required', 'CONFIG_DERIVATION_INVALID');
        const parent = read(source.podId);
        if (!parent || parent.workflow.agentMode !== 'interactive')
          configurationError(
            'Only an interactive launch can hand off',
            'CONFIG_SOURCE_CHANGED',
            409,
          );
        const expected = deriveLaunch(parent, {
          source,
          task: input.config.task,
          work: input.config.work,
          output: input.config.workflow.output,
        });
        if (configurationDigest(expected) !== configurationDigest(input.config))
          configurationError(
            'Worker handoff widened frozen authority',
            'CONFIG_DERIVATION_INVALID',
            403,
          );
        const owner = db
          .prepare(
            "SELECT 1 FROM pods WHERE id=? AND launch_config_digest=? AND lifecycle_generation=? AND status='running'",
          )
          .get(source.podId, parent.digest, input.expectedGeneration);
        if (!owner)
          configurationError('Workspace changed during handoff', 'CONFIG_SOURCE_CHANGED', 409);
        if (nextWorker(source.podId, parent))
          configurationError(
            'Workspace already has a pending handoff',
            'CONFIG_SOURCE_CHANGED',
            409,
          );
        db.prepare(
          'INSERT INTO pod_launch_phases(pod_id,digest,parent_digest,payload,created_at) VALUES(?,?,?,?,?)',
        ).run(
          source.podId,
          expected.digest,
          parent.digest,
          JSON.stringify(expected),
          new Date().toISOString(),
        );
        input.apply();
      })();
    },
    activateWorker(podId, expectedGeneration, apply) {
      return db.transaction(() => {
        const parent = read(podId);
        if (!parent) return false;
        const config = nextWorker(podId, parent);
        if (!config) return false;
        const marked = db
          .prepare(
            "UPDATE pods SET launch_config_digest=? WHERE id=? AND launch_config_digest=? AND lifecycle_generation=? AND status='handoff' AND container_id IS NULL",
          )
          .run(config.digest, podId, parent.digest, expectedGeneration).changes;
        if (marked !== 1)
          configurationError(
            'Workspace is not ready to activate its worker',
            'CONFIG_SOURCE_CHANGED',
            409,
          );
        apply(config);
        return true;
      })();
    },
    admit(input) {
      return db.transaction(() => {
        if (input.config.derivation?.kind === 'goal-rework')
          configurationError(
            'Goal rework must be an achieved Goal phase',
            'CONFIG_DERIVATION_INVALID',
          );
        if (input.requestId) {
          const previous = findRequest(input.requestId, input.requestDigest);
          if (previous) return { podId: previous, created: false };
        }
        const { digest, ...body } = input.config;
        if (digest !== configurationDigest(body))
          configurationError(
            'Launch configuration was modified after resolution',
            'CONFIG_CHANGED',
            409,
          );
        if (input.scanRepair) {
          const { reportId, selectionId } = input.scanRepair;
          const source = readScanConfiguration(db, reportId);
          const reports = createScanReportRepository(db);
          const decision = reports.getDecision(reportId, selectionId);
          if (!source || decision.actor.type !== 'human' || decision.action !== 'select_repair')
            configurationError(
              'A frozen human scan selection is required',
              'CONFIG_DERIVATION_INVALID',
              403,
            );
          const expected = deriveScanRepair(
            source,
            reports.get(reportId),
            selectionId,
            input.config.task,
          );
          if (expected.digest !== input.config.digest)
            configurationError(
              'Scan repair widened its frozen configuration',
              'CONFIG_DERIVATION_INVALID',
              403,
            );
        } else if (input.config.derivation) {
          const parent = this.get(input.config.derivation.podId);
          if (!parent)
            configurationError(
              'Derived launch source is unavailable',
              'CONFIG_SOURCE_MISSING',
              409,
            );
          const expected = deriveLaunch(parent, {
            source: input.config.derivation,
            task: input.config.task,
            work: input.config.work,
            ...(input.config.derivation.kind === 'worker'
              ? { output: input.config.workflow.output }
              : {}),
          });
          if (expected.digest !== input.config.digest)
            configurationError(
              'Derived launch widened its frozen configuration',
              'CONFIG_DERIVATION_INVALID',
              403,
            );
        } else store.assertCurrent(input.config.revisions);
        const podId = input.createPod();
        db.prepare(`INSERT INTO pod_launch_snapshots(pod_id,digest,payload,request_id,request_digest,created_at)
          VALUES(?,?,?,?,?,?)`).run(
          podId,
          digest,
          JSON.stringify(input.config),
          input.requestId ?? null,
          input.requestDigest,
          new Date().toISOString(),
        );
        const marked = db
          .prepare(
            'UPDATE pods SET launch_config_digest=? WHERE id=? AND launch_config_digest IS NULL',
          )
          .run(digest, podId).changes;
        if (marked !== 1)
          configurationError(
            'Pod already has a different launch identity',
            'SNAPSHOT_CONFLICT',
            409,
          );
        return { podId, created: true };
      })();
    },
  };
}
