-- @execute-whole
-- Explicit checkpoint continuation is NOT settlement of the original execution.
-- Originals and their resource holds remain immutable, even after a new result passes.
CREATE TABLE retained_checkpoint_recoveries (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  container_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  binding TEXT NOT NULL,
  original_evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (pod_id, generation),
  UNIQUE (container_id)
);
CREATE INDEX retained_checkpoint_task ON retained_checkpoint_recoveries(task_id);

CREATE TABLE retained_checkpoint_recovery_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  recovery_id TEXT NOT NULL REFERENCES retained_checkpoint_recoveries(id),
  kind TEXT NOT NULL CHECK (kind IN ('prepared', 'activated', 'checking', 'checked', 'blocked')),
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (recovery_id, kind)
);

CREATE TRIGGER retained_checkpoint_recoveries_no_update
BEFORE UPDATE ON retained_checkpoint_recoveries
BEGIN SELECT RAISE(ABORT, 'Retained checkpoint recovery identity is immutable'); END;
CREATE TRIGGER retained_checkpoint_recoveries_no_delete
BEFORE DELETE ON retained_checkpoint_recoveries
BEGIN SELECT RAISE(ABORT, 'Original source and execution custody cannot be deleted'); END;
CREATE TRIGGER retained_checkpoint_events_no_update
BEFORE UPDATE ON retained_checkpoint_recovery_events
BEGIN SELECT RAISE(ABORT, 'Retained checkpoint recovery evidence is immutable'); END;
CREATE TRIGGER retained_checkpoint_events_no_delete
BEFORE DELETE ON retained_checkpoint_recovery_events
BEGIN SELECT RAISE(ABORT, 'Retained checkpoint recovery evidence cannot be deleted'); END;
