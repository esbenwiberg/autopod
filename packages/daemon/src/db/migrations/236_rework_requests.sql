-- @execute-whole
CREATE TABLE rework_requests (
  request_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  actor TEXT NOT NULL,
  guidance TEXT NOT NULL,
  message_id INTEGER,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  error TEXT
);
CREATE UNIQUE INDEX rework_request_unsettled ON rework_requests(pod_id) WHERE settled_at IS NULL;
CREATE TRIGGER rework_request_identity BEFORE UPDATE ON rework_requests
WHEN NEW.request_key IS NOT OLD.request_key OR NEW.task_id IS NOT OLD.task_id
 OR NEW.pod_id IS NOT OLD.pod_id OR NEW.generation IS NOT OLD.generation
 OR NEW.actor IS NOT OLD.actor OR NEW.guidance IS NOT OLD.guidance
 OR NEW.message_id IS NOT OLD.message_id OR NEW.created_at IS NOT OLD.created_at
 OR OLD.settled_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Rework request identity and settlement are immutable'); END;
CREATE TRIGGER rework_request_retain BEFORE DELETE ON rework_requests
BEGIN SELECT RAISE(ABORT, 'Rework request is retained'); END;
