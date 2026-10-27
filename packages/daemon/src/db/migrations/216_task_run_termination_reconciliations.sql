-- @execute-whole
-- Independent of live pod/run foreign keys: receipts survive normal task history archival.
-- No fabricated exit observation or successful completion is recorded.
CREATE TABLE task_run_termination_reconciliations (
  run_id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  reconciled_at TEXT NOT NULL
);
CREATE INDEX task_run_termination_reconciliations_task ON task_run_termination_reconciliations(task_id);
CREATE TRIGGER task_run_termination_reconciliations_no_update
BEFORE UPDATE ON task_run_termination_reconciliations
BEGIN SELECT RAISE(ABORT, 'Termination reconciliation receipts are immutable'); END;
CREATE TRIGGER task_run_termination_reconciliations_no_delete
BEFORE DELETE ON task_run_termination_reconciliations
BEGIN SELECT RAISE(ABORT, 'Termination reconciliation receipts are immutable'); END;
