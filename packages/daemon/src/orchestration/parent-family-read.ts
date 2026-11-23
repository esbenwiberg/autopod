import type Database from 'better-sqlite3';

/** A projection only. Authorize the exact parent and run before calling. */
export function readParentFamily(
  db: Database.Database,
  podId: string,
  run: string,
  ownerDetails = false,
) {
  return {
    parent: podId,
    run: run,
    children: db
      .prepare(`
      SELECT q.request_key AS requestKey,q.parent_attempt AS parentAttempt,coalesce(c.pod_id,p.pod_id) AS child,
      CASE WHEN p.pod_id IS NULL AND c.pod_id IS NOT NULL THEN 'unknown'
        WHEN p.observed_exit=1 THEN 'exited'
        WHEN p.state='running' AND coalesce(p.last_runtime_observation,'running')<>'unknown' THEN 'started'
        WHEN p.allocation_attempted=1 THEN 'unknown' ELSE 'reserved' END AS status,
      CASE WHEN p.observed_exit=1 AND p.exit_code<>0 AND EXISTS (
        SELECT 1 FROM json_each(r.limitations_json)
        WHERE value='agent-provider-request-limit-reached'
      ) THEN 'provider-request-limit' END AS exitReason
      ${
        ownerDetails
          ? `,
      CASE WHEN p.observed_exit=1 THEN p.exit_code END AS exitCode,
      CASE WHEN q.private_scope_json IS NOT NULL AND p.observed_exit=1 AND p.exit_code=0 THEN
        CASE
          WHEN EXISTS (SELECT 1 FROM parent_private_candidates pc WHERE pc.pod_id=p.pod_id)
            THEN 'collected'
          WHEN EXISTS (
            SELECT 1 FROM json_each(r.limitations_json)
            WHERE value IN ('private-collection-incomplete','private-collection-uncertain')
          ) THEN 'unavailable'
          WHEN p.state='validating' THEN 'pending'
        END
      END AS collectionStatus`
          : ''
      }
      FROM orchestration_continuations c JOIN parent_managed_requests q ON q.run_id=c.run_id AND q.start_key=c.start_key LEFT JOIN managed_pods p
        ON p.dispatcher_installation_id='native.'||c.run_id AND p.managed_start_key=c.start_key
        AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
        AND p.dispatcher_attempt_id=c.attempt_id
        AND (c.pod_id IS NULL OR c.pod_id=p.pod_id)
      LEFT JOIN managed_results r ON r.pod_id=p.pod_id
      WHERE c.run_id=? ORDER BY c.rowid`)
      .all(run),
  };
}
