import type { CompactPod, Pod, PodFleetDisplay, PodRepositoryDisplay } from '@autopod/shared';

/** Only the source fields consumed by compact serialization; never a control-plane pod. */
export type CompactPodSource = Pick<
  Pod,
  | Extract<keyof CompactPod, keyof Pod>
  | 'task'
  | 'briefTitle'
  | 'progress'
  | 'pendingEscalation'
  | 'validationAttempts'
> & {
  repositoryDisplay?: PodRepositoryDisplay;
  activeTime?: PodFleetDisplay['activeTime'];
};

export const COMPACT_JSON_MAX_BYTES = 64 * 1024;
export const COMPACT_JSON_FIELDS = [
  'depends_on_pod_ids',
  'task_summary',
  'pending_escalation',
  'progress',
  'profile_snapshot',
] as const;

// SQL bounds values before they cross the SQLite/Node boundary. Unrelated prompts,
// contracts, spec files and validation evidence are not selected or parsed at all.
export const COMPACT_POD_COLUMNS = [
  'completion_policy',
  'id',
  'profile_name',
  'status',
  'model',
  'runtime',
  'execution_target',
  'branch',
  'base_branch',
  'series_id',
  'series_name',
  `CASE WHEN length(CAST(depends_on_pod_id AS BLOB)) <= ${COMPACT_JSON_MAX_BYTES} THEN depends_on_pod_id END AS depends_on_pod_id`,
  `length(CAST(depends_on_pod_id AS BLOB)) > ${COMPACT_JSON_MAX_BYTES} AS depends_on_pod_id_oversized`,
  'output_mode',
  'agent_mode',
  'output_target',
  'validate',
  'validation_suite',
  'advisory_browser_qa_enabled',
  'promotable',
  'container_id',
  'worktree_path',
  'preview_url',
  'created_at',
  'started_at',
  'running_at',
  'updated_at',
  'completed_at',
  '(SELECT elapsed_ms FROM pod_active_time WHERE pod_id = pods.id) AS active_elapsed_ms',
  '(SELECT active_since FROM pod_active_time WHERE pod_id = pods.id) AS active_since',
  'last_heartbeat_at',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'token_telemetry_accuracy',
  'files_changed',
  'lines_added',
  'lines_removed',
  'lifecycle_generation',
  'last_recovery_trigger',
  'validation_attempts',
  'substr(CAST(task AS TEXT), 1, 2000) AS task',
  'substr(brief_title, 1, 160) AS brief_title',
  'substr(failure_reason, 1, 500) AS failure_reason',
  'substr(merge_block_reason, 1, 500) AS merge_block_reason',
  'substr(last_correction_message, 1, 500) AS last_correction_message',
  ...COMPACT_JSON_FIELDS.flatMap((field) => [
    `CASE WHEN length(CAST(${field} AS BLOB)) <= ${COMPACT_JSON_MAX_BYTES} THEN ${field} ELSE NULL END AS ${field}`,
    `length(CAST(${field} AS BLOB)) > ${COMPACT_JSON_MAX_BYTES} AS ${field}_oversized`,
  ]),
].join(', ');
