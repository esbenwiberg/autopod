import {
  type EffectiveLaunchConfig,
  type Pod,
  type SeriesLaunchRequest,
  inspectSeriesBriefGraph,
  inspectSpecContract,
  launchWorkSchema,
  orderSeriesBriefs,
  seriesLaunchRequestSchema,
} from '@autopod/shared';
import type Database from 'better-sqlite3';
import { configurationError } from './configuration-store.js';
import {
  type LaunchResolutionServices,
  configurationDigest,
  resolveLaunch,
} from './launch-resolver.js';
import type { LaunchSnapshotRepository } from './launch-snapshot.js';
import { resolveExecution } from './resolve-execution.js';

export interface SeriesAdmission {
  seriesId: string;
  seriesName: string;
  pods: Array<{ title: string; pod: Pod }>;
}
export interface SeriesLaunches {
  create(request: unknown, owner: string): Promise<SeriesAdmission>;
}

/** One resolution, one transaction and one durable receipt for the complete DAG. */
export function createSeriesLaunches(options: {
  db: Database.Database;
  resolution: LaunchResolutionServices;
  snapshots: LaunchSnapshotRepository;
  ready(): boolean;
  create(config: EffectiveLaunchConfig, owner: string): Pod;
  read(id: string): Pod;
}): SeriesLaunches {
  const { db, snapshots, resolution } = options;
  function replay(requestId: string, requestDigest: string): SeriesAdmission | null {
    const row = db
      .prepare('SELECT * FROM series_launch_receipts WHERE request_id=?')
      .get(requestId) as
      | { request_digest: string; series_id: string; series_name: string; pods: string }
      | undefined;
    if (!row) return null;
    if (row.request_digest !== requestDigest)
      configurationError(
        'Series request ID belongs to a different request',
        'REQUEST_CONFLICT',
        409,
      );
    const references = JSON.parse(row.pods) as Array<{ title: string; podId: string }>;
    return {
      seriesId: row.series_id,
      seriesName: row.series_name,
      pods: references.map(({ title, podId }) => ({ title, pod: options.read(podId) })),
    };
  }
  function assertReady() {
    if (!options.ready())
      configurationError(
        'Configuration cutover is incomplete or admission is suspended',
        'CONFIG_CUTOVER_REQUIRED',
        409,
      );
  }
  return {
    async create(raw, owner) {
      const request = seriesLaunchRequestSchema.parse(raw);
      const requestDigest = configurationDigest({ request, owner });
      // A lost response remains recoverable even if the operator subsequently pauses admission.
      const previous = replay(request.requestId, requestDigest);
      if (previous) return previous;
      assertReady();
      const diagnostics = [
        ...inspectSeriesBriefGraph(request.briefs),
        ...request.briefs.flatMap((brief, index) =>
          brief.contract
            ? inspectSpecContract(brief.contract, `briefs[${index}].contract`).diagnostics
            : [],
        ),
      ];
      if (diagnostics.length)
        configurationError(
          `Series preflight failed: ${diagnostics.map((item) => item.message).join('; ')}`,
          'SERIES_PREFLIGHT_FAILED',
        );
      const briefs = orderSeriesBriefs(request.briefs);
      const base = await resolveLaunch({ ...request.launch, task: request.seriesName }, resolution);
      if (!base.repository || base.workflow.agentMode !== 'auto' || base.intent !== 'task')
        configurationError(
          'Series require a repository and an automatic Task workflow',
          'SERIES_WORKFLOW_UNSUPPORTED',
        );
      const seriesId = `series-${configurationDigest({ owner, requestId: request.requestId }).slice(0, 24)}`;
      const capabilities = await resolution.executionCapabilities(base.execution.target);
      const prepared: EffectiveLaunchConfig[] = [];
      for (const [index, brief] of briefs.entries()) {
        const requiredSidecarIds = [
          ...new Set([...base.requiredSidecarIds, ...(brief.requireSidecars ?? [])]),
        ];
        const { digest: _, ...frozen } = base;
        const config = {
          ...frozen,
          task: brief.task,
          origin: { kind: 'series' as const, seriesId, briefTitle: brief.title },
          provenance: {
            ...base.provenance,
            task: { source: 'override' as const },
            work: { source: 'override' as const },
            'workflow.output': { source: 'override' as const },
          },
          requiredSidecarIds,
          resolvedExecution: resolveExecution({
            environment: base.environment,
            execution: { ...base.execution, main: base.resolvedExecution.main },
            requiredSidecarIds,
            trustedRepository: base.repository.config.trustedSetupIds.includes(
              base.repository.setup.id,
            ),
            capabilities,
          }),
          workflow: {
            ...base.workflow,
            output:
              request.prMode === 'stacked' ||
              (request.prMode === 'single' && index === briefs.length - 1)
                ? ('pr' as const)
                : ('branch' as const),
          },
          work: {},
        };
        const sealed = { ...config, digest: configurationDigest(config) };
        await resolution.assertCapabilities(sealed);
        prepared.push(sealed);
      }
      return db.transaction(() => {
        const raced = replay(request.requestId, requestDigest);
        if (raced) return raced;
        assertReady();
        resolution.store.assertCurrent(base.revisions);
        const created: SeriesAdmission['pods'] = [];
        const titleToId = new Map<string, string>();
        let sharedBranch: string | undefined;
        for (const [index, brief] of briefs.entries()) {
          const selected = prepared[index];
          if (!selected) throw new Error('Missing series configuration');
          const root = brief.dependsOn.length === 0;
          const dependencies = brief.dependsOn.map((title) => {
            const id = titleToId.get(title);
            if (!id) throw new Error('Missing series parent');
            return id;
          });
          const last = created.at(-1);
          if (request.prMode === 'single' && last) dependencies.push(last.pod.id);
          const work = seriesWork(request, brief, seriesId, root);
          work.dependsOnPodIds = [...new Set(dependencies)];
          // Even another DAG root serializes on the first branch in single mode.
          if (request.prMode === 'single' && index > 0) {
            work.branch = sharedBranch;
            work.startBranch = undefined;
            work.specFiles = undefined;
          }
          const { digest: _, ...body } = selected;
          const payload = { ...body, work: launchWorkSchema.parse(work) };
          const config = { ...payload, digest: configurationDigest(payload) };
          const admitted = snapshots.admit({
            config,
            requestDigest,
            createPod: () => options.create(config, owner).id,
          });
          const pod = options.read(admitted.podId);
          if (index === 0) sharedBranch = pod.branch;
          titleToId.set(brief.title, pod.id);
          created.push({ title: brief.title, pod });
        }
        db.prepare(
          'INSERT INTO series_launch_receipts(request_id,request_digest,series_id,series_name,pods,created_at) VALUES(?,?,?,?,?,?)',
        ).run(
          request.requestId,
          requestDigest,
          seriesId,
          request.seriesName,
          JSON.stringify(created.map(({ title, pod }) => ({ title, podId: pod.id }))),
          new Date().toISOString(),
        );
        return { seriesId, seriesName: request.seriesName, pods: created };
      })();
    },
  };
}

function seriesWork(
  request: SeriesLaunchRequest,
  brief: SeriesLaunchRequest['briefs'][number],
  seriesId: string,
  root: boolean,
): EffectiveLaunchConfig['work'] {
  return {
    startBranch: root ? request.startBranch : undefined,
    baseBranch: request.baseBranch,
    specFiles: root ? request.specFiles : undefined,
    specContextFiles: request.specContextFiles,
    seriesId,
    seriesName: request.seriesName,
    briefTitle: brief.title,
    seriesDescription: request.seriesDescription,
    seriesDesign: request.seriesDesign,
    prMode: request.prMode,
    contract: brief.contract,
    touches: brief.touches,
    doesNotTouch: brief.doesNotTouch,
    waitForMerge: request.prMode === 'stacked' && !root,
  };
}
