-- @execute-whole
-- Durable stop selection, not a retry grant. No cascade: retain original evidence.
CREATE TABLE stalled_worker_recoveries (
  request_key TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  binding TEXT NOT NULL CHECK(json_valid(binding)),
  receipt TEXT NOT NULL CHECK(json_valid(receipt)),
  archive_path TEXT NOT NULL,
  original_evidence TEXT NOT NULL CHECK(json_valid(original_evidence)),
  stop_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(stop_dispatched IN (0,1)),
  preservation TEXT CHECK(preservation IS NULL OR json_valid(preservation))
);
CREATE UNIQUE INDEX stalled_worker_pending_task ON stalled_worker_recoveries(task_id)
  WHERE json_extract(receipt,'$.state')='pending';
CREATE INDEX stalled_worker_resource ON stalled_worker_recoveries(container_id);
CREATE TRIGGER stalled_worker_recovery_immutable BEFORE UPDATE ON stalled_worker_recoveries
WHEN NEW.request_key IS NOT OLD.request_key OR NEW.pod_id IS NOT OLD.pod_id
  OR NEW.task_id IS NOT OLD.task_id OR NEW.container_id IS NOT OLD.container_id
  OR NEW.request_hash IS NOT OLD.request_hash OR NEW.binding IS NOT OLD.binding
  OR NEW.archive_path IS NOT OLD.archive_path OR NEW.original_evidence IS NOT OLD.original_evidence
  OR NEW.stop_dispatched<OLD.stop_dispatched
  OR json_extract(NEW.receipt,'$.request') IS NOT json_extract(OLD.receipt,'$.request')
  OR json_extract(NEW.receipt,'$.actor') IS NOT json_extract(OLD.receipt,'$.actor')
  OR json_extract(NEW.receipt,'$.createdAt') IS NOT json_extract(OLD.receipt,'$.createdAt')
  OR json_extract(OLD.receipt,'$.state')='settled'
BEGIN SELECT RAISE(ABORT,'Stalled recovery identity and settled evidence are immutable'); END;
CREATE TRIGGER stalled_worker_recovery_no_delete BEFORE DELETE ON stalled_worker_recoveries
BEGIN SELECT RAISE(ABORT,'Stalled recovery evidence cannot be deleted'); END;
CREATE TRIGGER stalled_worker_new_run_fence BEFORE INSERT ON task_agent_runs
WHEN EXISTS(SELECT 1 FROM stalled_worker_recoveries s JOIN task_executions e ON e.task_id=s.task_id
  WHERE e.pod_id=NEW.pod_id AND json_extract(s.receipt,'$.state')='pending')
BEGIN SELECT RAISE(ABORT,'Stop-and-retain owns this task; no new worker run'); END;
CREATE TRIGGER stalled_worker_new_admission_fence BEFORE INSERT ON task_retry_attempts
WHEN EXISTS(SELECT 1 FROM stalled_worker_recoveries s WHERE s.task_id=NEW.task_id
  AND json_extract(s.receipt,'$.state')='pending')
BEGIN SELECT RAISE(ABORT,'Stop-and-retain owns this task; no new execution admission'); END;
