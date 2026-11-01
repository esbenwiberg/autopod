-- @execute-whole
-- Append a separately audited observation of already-published replacement checks.
-- Original blocked/checking events and unknown-original resource holds never change.
CREATE TABLE retained_checkpoint_outcome_reconciliations (
  recovery_id TEXT PRIMARY KEY REFERENCES retained_checkpoint_recoveries(id),
  request_hash TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER retained_checkpoint_outcomes_no_update
BEFORE UPDATE ON retained_checkpoint_outcome_reconciliations
BEGIN SELECT RAISE(ABORT, 'Checkpoint outcome reconciliation is immutable'); END;
CREATE TRIGGER retained_checkpoint_outcomes_no_delete
BEFORE DELETE ON retained_checkpoint_outcome_reconciliations
BEGIN SELECT RAISE(ABORT, 'Checkpoint outcome reconciliation cannot be deleted'); END;
