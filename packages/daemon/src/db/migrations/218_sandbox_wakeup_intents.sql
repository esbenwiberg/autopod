-- @execute-whole
-- Running observations authorize future wakes, not worker execution or task settlement.
CREATE TABLE sandbox_wakeup_baselines (
  resource_key TEXT PRIMARY KEY CHECK(length(resource_key) BETWEEN 1 AND 2048),
  sandbox_id TEXT NOT NULL CHECK(length(sandbox_id) BETWEEN 1 AND 256),
  observed_at TEXT NOT NULL
);
CREATE TABLE sandbox_wakeup_intents (
  id TEXT PRIMARY KEY,
  resource_key TEXT NOT NULL REFERENCES sandbox_wakeup_baselines(resource_key),
  sandbox_id TEXT NOT NULL,
  pod_id TEXT,
  started_at TEXT NOT NULL,
  dispatch_started_at TEXT,
  ended_at TEXT,
  settled_by TEXT CHECK(settled_by IN ('observed-running','resource-locked','dispatch-revoked')),
  CHECK((ended_at IS NULL) = (settled_by IS NULL)),
  CHECK(settled_by != 'dispatch-revoked' OR dispatch_started_at IS NULL),
  CHECK(settled_by != 'resource-locked' OR dispatch_started_at IS NOT NULL)
);
CREATE UNIQUE INDEX sandbox_wakeup_one_pending ON sandbox_wakeup_intents(resource_key)
  WHERE ended_at IS NULL;
CREATE TRIGGER sandbox_wakeup_baseline_no_update BEFORE UPDATE ON sandbox_wakeup_baselines
BEGIN SELECT RAISE(ABORT,'Sandbox wakeup baseline is immutable'); END;
CREATE TRIGGER sandbox_wakeup_baseline_no_delete BEFORE DELETE ON sandbox_wakeup_baselines
BEGIN SELECT RAISE(ABORT,'Sandbox wakeup baseline is immutable'); END;
CREATE TRIGGER sandbox_wakeup_no_delete BEFORE DELETE ON sandbox_wakeup_intents
BEGIN SELECT RAISE(ABORT,'Sandbox wakeup intent is immutable'); END;
CREATE TRIGGER sandbox_wakeup_guard BEFORE UPDATE ON sandbox_wakeup_intents
WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id
 OR NEW.resource_key IS NOT OLD.resource_key OR NEW.sandbox_id IS NOT OLD.sandbox_id
 OR NEW.pod_id IS NOT OLD.pod_id
 OR NEW.started_at IS NOT OLD.started_at
 OR (OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS NOT OLD.dispatch_started_at)
 OR (NEW.ended_at IS NULL AND (NEW.dispatch_started_at IS NULL OR OLD.dispatch_started_at IS NOT NULL))
 OR (NEW.ended_at IS NOT NULL AND NEW.dispatch_started_at IS NOT OLD.dispatch_started_at)
BEGIN SELECT RAISE(ABORT,'Sandbox wakeup evidence is immutable'); END;
