import path from 'node:path';
import type { Pod } from '@autopod/shared';
import type Database from 'better-sqlite3';

export interface RetainedPrevalidationSource {
  version: 1;
  requestKey: string;
  taskId: string;
  runId: string;
  generation: number;
  cycle: number;
  resourceKey: string;
  head: string;
  tree: string;
  archiveSha256: string;
  archivePath: string;
}

/** Positive sealed source evidence, never an inferred worker result or validation pass. */
export function retainedPrevalidationSource(
  db: Database.Database,
  pod: Pod,
): RetainedPrevalidationSource | null {
  const finalization = pod.finalization;
  if (
    pod.lastValidationResult ||
    pod.status !== 'failed' ||
    pod.executionTarget !== 'local' ||
    !pod.launchConfigDigest ||
    !pod.worktreePath ||
    !pod.containerId ||
    finalization?.generation !== pod.lifecycleGeneration ||
    finalization.phase !== 'ready' ||
    !finalization.agentSettledAt ||
    !finalization.sourcePreservedAt
  )
    return null;
  // Extract bounded scalar evidence only; original pod/report contents remain private.
  const rows = db
    .prepare(`SELECT s.request_key AS requestKey,s.task_id AS taskId,
    r.id AS runId,r.generation,r.cycle,
    substr(json_extract(s.binding,'$.resourceKey'),1,4097) AS resourceKey,
    substr(json_extract(s.preservation,'$.archivedSource.commitSha'),1,65) AS head,
    substr(json_extract(s.preservation,'$.archivedSource.treeSha'),1,65) AS tree,
    substr(json_extract(s.preservation,'$.archiveFingerprint.sha256'),1,65) AS archiveSha256,
    substr(s.archive_path,1,4097) AS archivePath
    FROM stalled_worker_recoveries s
    JOIN task_executions e ON e.pod_id=s.pod_id AND e.task_id=s.task_id
    JOIN task_agent_runs r ON r.id=json_extract(s.binding,'$.run.id') AND r.pod_id=s.pod_id
    WHERE s.pod_id=? AND s.container_id=? AND r.generation=? AND r.cycle=?
      AND r.ended_at IS NOT NULL
      AND json_extract(s.receipt,'$.state')='settled'
      AND json_type(s.receipt,'$.resourcesRetained')='true'
      AND json_extract(s.receipt,'$.request.expectedGeneration')=r.generation
      AND json_extract(s.binding,'$.run.generation')=r.generation
      AND json_extract(s.binding,'$.run.cycle')=r.cycle
      AND json_extract(s.binding,'$.run.binding')=r.binding
      AND json_extract(r.binding,'$.resource.containerId')=s.container_id
      AND json_extract(r.binding,'$.resource.executionTarget')='local'
      AND json_type(s.original_evidence,'$.pod.lastValidationResult')='null'
      AND json_extract(s.original_evidence,'$.pod.worktreePath')=?
      AND json_extract(s.preservation,'$.proof')='docker-stopped'
      AND json_extract(s.preservation,'$.archivePath')=s.archive_path
      AND json_extract(s.preservation,'$.resourceKey')=json_extract(s.binding,'$.resourceKey')
      AND json_extract(s.preservation,'$.archivedSource.branch')=?
      AND json_type(s.preservation,'$.archivedSource.worktreeClean')='true'
      AND json_extract(s.preservation,'$.source')=json_extract(s.preservation,'$.archivedSource')
      AND NOT EXISTS(SELECT 1 FROM validation_dispatches d WHERE d.task_id=s.task_id)
      AND NOT EXISTS(SELECT 1 FROM validations v JOIN task_executions ve ON ve.pod_id=v.pod_id WHERE ve.task_id=s.task_id)
      AND NOT EXISTS(SELECT 1 FROM task_retry_attempts a WHERE a.task_id=s.task_id AND a.stage='validation')
    LIMIT 2`)
    .all(
      pod.id,
      pod.containerId,
      pod.lifecycleGeneration,
      finalization.cycle,
      pod.worktreePath,
      pod.branch,
    ) as Omit<RetainedPrevalidationSource, 'version'>[];
  const source = rows[0];
  if (
    rows.length !== 1 ||
    !source ||
    !source.requestKey ||
    source.requestKey.length > 64 ||
    typeof source.resourceKey !== 'string' ||
    !source.resourceKey ||
    source.resourceKey.length > 4096 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.head ?? '') ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.tree ?? '') ||
    !/^[a-f0-9]{64}$/.test(source.archiveSha256 ?? '') ||
    typeof source.archivePath !== 'string' ||
    source.archivePath.length > 4096 ||
    !path.isAbsolute(source.archivePath)
  )
    return null;
  let resource: unknown;
  try {
    resource = JSON.parse(source.resourceKey);
  } catch {
    return null;
  }
  if (
    !Array.isArray(resource) ||
    resource.length !== 3 ||
    resource[0] !== 'docker' ||
    typeof resource[1] !== 'string' ||
    !resource[1] ||
    resource[2] !== pod.containerId
  )
    return null;
  return { version: 1, ...source };
}
