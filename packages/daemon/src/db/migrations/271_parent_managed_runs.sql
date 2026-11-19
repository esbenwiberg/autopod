-- A future launch request can commission one parent lifetime. Never adopt an existing worker.
CREATE TABLE parent_managed_runs (
  run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id),
  pod_id TEXT NOT NULL UNIQUE,
  launch_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  current_attempt TEXT
);
CREATE TABLE parent_managed_requests (
  run_id TEXT NOT NULL REFERENCES parent_managed_runs(run_id),
  start_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  parent_attempt TEXT NOT NULL REFERENCES parent_managed_sessions(attempt),
  input_digest TEXT NOT NULL,
  PRIMARY KEY(run_id, start_key),
  UNIQUE(run_id, request_key),
  FOREIGN KEY(run_id,start_key) REFERENCES orchestration_continuations(run_id,start_key)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE parent_managed_sessions (
  attempt TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES parent_managed_runs(run_id),
  generation INTEGER NOT NULL,
  container_id TEXT NOT NULL
);
ALTER TABLE managed_pods ADD COLUMN last_runtime_observation TEXT;
CREATE TRIGGER parent_managed_policy_immutable BEFORE UPDATE OF run_id,pod_id,launch_digest,policy_digest,policy_json ON parent_managed_runs
BEGIN SELECT RAISE(ABORT,'parent policy is immutable'); END;
CREATE TRIGGER parent_managed_history_retained BEFORE DELETE ON parent_managed_runs
BEGIN SELECT RAISE(ABORT,'parent history is retained'); END;
CREATE TRIGGER parent_managed_session_immutable BEFORE UPDATE ON parent_managed_sessions
BEGIN SELECT RAISE(ABORT,'parent session is immutable'); END;
CREATE TRIGGER parent_managed_request_immutable BEFORE UPDATE ON parent_managed_requests
BEGIN SELECT RAISE(ABORT,'parent request is immutable'); END;
