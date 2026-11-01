-- @execute-whole
-- Human recovery decisions do not reinterpret a lost provider response.
-- No FK to pods: receipts and original wakeup evidence survive pod deletion.
CREATE TABLE sandbox_recovery_requests (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('start','abandon')),
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  binding TEXT NOT NULL,
  intent_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(length(binding)=64),
  CHECK(json_valid(intent_ids))
);
CREATE INDEX sandbox_abandonments_by_resource ON sandbox_recovery_requests(resource_key)
  WHERE action='abandon';
CREATE INDEX sandbox_recovery_by_pod ON sandbox_recovery_requests(pod_id,created_at);
CREATE TRIGGER sandbox_recovery_no_delete BEFORE DELETE ON sandbox_recovery_requests
BEGIN SELECT RAISE(ABORT,'Recovery decisions are retained'); END;
CREATE TRIGGER sandbox_recovery_guard BEFORE UPDATE ON sandbox_recovery_requests
WHEN OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL
 OR NEW.id IS NOT OLD.id OR NEW.pod_id IS NOT OLD.pod_id
 OR NEW.sandbox_id IS NOT OLD.sandbox_id OR NEW.resource_key IS NOT OLD.resource_key
 OR NEW.generation IS NOT OLD.generation OR NEW.action IS NOT OLD.action
 OR NEW.user_id IS NOT OLD.user_id OR NEW.reason IS NOT OLD.reason
 OR NEW.request_hash IS NOT OLD.request_hash OR NEW.binding IS NOT OLD.binding
 OR NEW.intent_ids IS NOT OLD.intent_ids OR NEW.created_at IS NOT OLD.created_at
 OR NOT EXISTS(SELECT 1 FROM sandbox_recovery_events e WHERE e.request_id=OLD.id
   AND e.kind=CASE OLD.action WHEN 'abandon' THEN 'deleted' ELSE 'running' END)
BEGIN SELECT RAISE(ABORT,'Recovery decision identity is immutable'); END;
CREATE TABLE sandbox_recovery_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES sandbox_recovery_requests(id),
  kind TEXT NOT NULL CHECK(kind IN ('admitted','dispatch','running','deleted','unverified')),
  recorded_at TEXT NOT NULL
);
CREATE TRIGGER sandbox_recovery_events_no_update BEFORE UPDATE ON sandbox_recovery_events
BEGIN SELECT RAISE(ABORT,'Recovery evidence is immutable'); END;
CREATE TRIGGER sandbox_recovery_events_no_delete BEFORE DELETE ON sandbox_recovery_events
BEGIN SELECT RAISE(ABORT,'Recovery evidence is retained'); END;
