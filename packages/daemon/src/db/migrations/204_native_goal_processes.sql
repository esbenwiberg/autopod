-- @execute-whole
CREATE TABLE pod_goal_processes (
  exec_id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  configuration_digest TEXT NOT NULL,
  account_id TEXT NOT NULL,
  backend TEXT NOT NULL CHECK(backend='docker'),
  container_id TEXT NOT NULL,
  pid_path TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('agent','inspection')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  stopped_at TEXT,
  exit_code INTEGER
);
CREATE INDEX pod_goal_processes_attempt ON pod_goal_processes(pod_id,attempt_id,generation);
CREATE TRIGGER pod_goal_process_identity_immutable BEFORE UPDATE ON pod_goal_processes
WHEN NEW.exec_id IS NOT OLD.exec_id OR NEW.pod_id IS NOT OLD.pod_id
  OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.generation IS NOT OLD.generation
  OR NEW.configuration_digest IS NOT OLD.configuration_digest OR NEW.account_id IS NOT OLD.account_id
  OR NEW.backend IS NOT OLD.backend OR NEW.container_id IS NOT OLD.container_id
  OR NEW.pid_path IS NOT OLD.pid_path OR NEW.role IS NOT OLD.role OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
  OR (OLD.stopped_at IS NOT NULL AND (NEW.stopped_at IS NOT OLD.stopped_at OR NEW.exit_code IS NOT OLD.exit_code))
BEGIN SELECT RAISE(ABORT, 'native Goal process identity is immutable'); END;
