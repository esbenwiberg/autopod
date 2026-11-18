-- Internal native orchestration ledger. A launch intent IS the request reservation:
-- losing the reply, canceling, or losing a runtime observation cannot release it.
CREATE TABLE orchestration_runs (
  id TEXT PRIMARY KEY NOT NULL,
  repository TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  accepted_commit TEXT NOT NULL,
  worker_request_limit INTEGER NOT NULL CHECK(worker_request_limit > 0),
  canceled INTEGER NOT NULL DEFAULT 0 CHECK(canceled IN (0,1))
);
CREATE TABLE orchestration_continuations (
  run_id TEXT NOT NULL REFERENCES orchestration_runs(id),
  start_key TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  operation_digest TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  reserved_requests INTEGER NOT NULL CHECK(reserved_requests > 0),
  pod_id TEXT REFERENCES managed_pods(pod_id),
  PRIMARY KEY(run_id, start_key),
  UNIQUE(run_id, attempt_id)
);
CREATE INDEX orchestration_pending ON orchestration_continuations(run_id) WHERE pod_id IS NULL;
