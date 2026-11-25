-- @execute-whole
ALTER TABLE pods ADD COLUMN failure_closed_at TEXT;
ALTER TABLE pods ADD COLUMN failure_closed_by TEXT;
ALTER TABLE task_history_pods ADD COLUMN failure_closed_at TEXT;
ALTER TABLE task_history_pods ADD COLUMN failure_closed_by TEXT;

-- Resuming/retrying (even in the same generation) never acknowledges a later failure.
CREATE TRIGGER reset_failure_closeout AFTER UPDATE OF status, lifecycle_generation, completed_at, failure_reason, container_id, execution_target ON pods
WHEN NEW.failure_closed_at IS NOT NULL
  AND (NEW.status != 'failed' OR NEW.lifecycle_generation != OLD.lifecycle_generation
       OR NEW.completed_at IS NOT OLD.completed_at OR NEW.failure_reason IS NOT OLD.failure_reason
       OR NEW.execution_target != OLD.execution_target
       OR (NEW.container_id IS NOT NULL AND NEW.container_id IS NOT OLD.container_id))
BEGIN
  UPDATE pods SET failure_closed_at = NULL, failure_closed_by = NULL WHERE id = NEW.id;
END;
