-- @execute-whole
CREATE TABLE validation_dispatches (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  admission_id TEXT NOT NULL UNIQUE,
  binding TEXT NOT NULL CHECK(json_valid(binding)),
  created_at TEXT NOT NULL
);
CREATE TABLE validation_dispatch_results (
  dispatch_id TEXT PRIMARY KEY REFERENCES validation_dispatches(id),
  result_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result))
);
CREATE TABLE validation_recovery_intents (
  dispatch_id TEXT PRIMARY KEY REFERENCES validation_dispatches(id),
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(json_valid(actor)),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  preservation TEXT CHECK(json_valid(preservation)),
  deletion_started_at TEXT,
  receipt TEXT CHECK(json_valid(receipt))
);
CREATE TABLE validation_recovery_budgets (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  result_hash TEXT NOT NULL,
  binding TEXT NOT NULL,
  seconds INTEGER NOT NULL CHECK(seconds BETWEEN 1 AND 3600),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  dispatch_id TEXT UNIQUE REFERENCES validation_dispatches(id)
);
CREATE TRIGGER validation_dispatches_immutable_update BEFORE UPDATE ON validation_dispatches
BEGIN SELECT RAISE(ABORT,'Validation dispatch identity is immutable'); END;
CREATE TRIGGER validation_dispatches_immutable_delete BEFORE DELETE ON validation_dispatches
BEGIN SELECT RAISE(ABORT,'Validation dispatch identity is immutable'); END;
CREATE TRIGGER validation_results_immutable_update BEFORE UPDATE ON validation_dispatch_results
BEGIN SELECT RAISE(ABORT,'Validation dispatch result is immutable'); END;
CREATE TRIGGER validation_results_immutable_delete BEFORE DELETE ON validation_dispatch_results
BEGIN SELECT RAISE(ABORT,'Validation dispatch result is immutable'); END;
CREATE TRIGGER validation_recovery_no_delete BEFORE DELETE ON validation_recovery_intents
BEGIN SELECT RAISE(ABORT,'Validation recovery evidence is immutable'); END;
CREATE TRIGGER validation_recovery_guard BEFORE UPDATE ON validation_recovery_intents
WHEN NEW.dispatch_id IS NOT OLD.dispatch_id OR NEW.pod_id IS NOT OLD.pod_id
 OR NEW.task_id IS NOT OLD.task_id OR NEW.actor IS NOT OLD.actor OR NEW.reason IS NOT OLD.reason
 OR NEW.created_at IS NOT OLD.created_at OR OLD.receipt IS NOT NULL
 OR (OLD.preservation IS NOT NULL AND NEW.preservation IS NOT OLD.preservation)
 OR (OLD.deletion_started_at IS NOT NULL AND NEW.deletion_started_at IS NOT OLD.deletion_started_at)
BEGIN SELECT RAISE(ABORT,'Validation recovery evidence is immutable'); END;
CREATE TRIGGER validation_budget_no_delete BEFORE DELETE ON validation_recovery_budgets
BEGIN SELECT RAISE(ABORT,'Recovery budget audit is immutable'); END;
CREATE TRIGGER validation_budget_guard BEFORE UPDATE ON validation_recovery_budgets
WHEN NEW.id IS NOT OLD.id OR NEW.pod_id IS NOT OLD.pod_id OR NEW.task_id IS NOT OLD.task_id
 OR NEW.generation IS NOT OLD.generation OR NEW.result_hash IS NOT OLD.result_hash
 OR NEW.binding IS NOT OLD.binding OR NEW.seconds IS NOT OLD.seconds OR NEW.actor IS NOT OLD.actor
 OR NEW.reason IS NOT OLD.reason OR NEW.created_at IS NOT OLD.created_at
 OR NEW.expires_at IS NOT OLD.expires_at OR OLD.dispatch_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Recovery budget audit is immutable'); END;
-- Preservation may import host source: never run it concurrently across daemon instances.
-- An interrupted attempt without a saved snapshot stays fenced for evidence investigation.
CREATE TABLE validation_preservation_attempts (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES validation_dispatches(id),
  started_at TEXT NOT NULL,
  settled_at TEXT,
  outcome TEXT CHECK(outcome IN ('failed','preserved'))
);
CREATE UNIQUE INDEX validation_preservation_one_active ON validation_preservation_attempts(dispatch_id)
  WHERE settled_at IS NULL;
CREATE TRIGGER validation_preservation_no_delete BEFORE DELETE ON validation_preservation_attempts
BEGIN SELECT RAISE(ABORT,'Preservation attempt evidence is immutable'); END;
CREATE TRIGGER validation_preservation_guard BEFORE UPDATE ON validation_preservation_attempts
WHEN OLD.settled_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.dispatch_id IS NOT OLD.dispatch_id
 OR NEW.started_at IS NOT OLD.started_at OR NEW.settled_at IS NULL OR NEW.outcome IS NULL
BEGIN SELECT RAISE(ABORT,'Preservation attempt evidence is immutable'); END;
