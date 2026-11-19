-- Observations only. A live operation can acquire a handle or reply at any time.
CREATE VIEW orchestration_unknown_outcomes AS
SELECT run_id, 'controller' AS kind, wait_key AS key, wake_digest AS binding,
       NULL AS pod_id, 1 AS reserved_requests
FROM orchestration_controller_turns WHERE status='reserved' AND decision_json IS NULL
UNION ALL
SELECT c.run_id, 'allocation', c.start_key, c.operation_digest, p.pod_id, c.reserved_requests
FROM orchestration_continuations c JOIN managed_pods p
  ON p.dispatcher_installation_id=('native.' || c.run_id) AND p.managed_start_key=c.start_key
  AND p.dispatcher_attempt_id=c.attempt_id AND p.execution_spec_digest=json_extract(c.request_json,'$.executionSpecDigest')
WHERE p.allocation_attempted=1 AND p.runtime_ref IS NULL AND p.observed_exit=0;

-- An intervention fences a run, not its accounting or the runtime observation lane.
-- Keep the original observation even if later evidence arrives. No mutable resolution flag.
CREATE TABLE orchestration_unknown_fences (
  run_id TEXT NOT NULL REFERENCES orchestration_runs(id), kind TEXT NOT NULL CHECK(kind IN ('controller','allocation')),
  key TEXT NOT NULL, binding TEXT NOT NULL, pod_id TEXT, reserved_requests INTEGER NOT NULL CHECK(reserved_requests>0),
  actor TEXT NOT NULL, case_ref TEXT NOT NULL, recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(run_id,kind,key)
);
