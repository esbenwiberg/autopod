-- @execute-whole
-- Admission identity distinguishes legacy pods from pods that must have an immutable launch snapshot.
ALTER TABLE pods ADD COLUMN launch_config_digest TEXT;
ALTER TABLE task_history_pods ADD COLUMN launch_config_digest TEXT;

-- Configuration and external-effect identity outlive removal from the operator pod list.
CREATE TABLE task_history_pod_launch_snapshots AS SELECT * FROM pod_launch_snapshots WHERE 0;
CREATE UNIQUE INDEX task_history_launch_snapshot_identity ON task_history_pod_launch_snapshots(pod_id);
CREATE UNIQUE INDEX task_history_launch_request_identity ON task_history_pod_launch_snapshots(request_id);
CREATE VIEW retained_pod_launch_snapshots AS SELECT l.* FROM pod_launch_snapshots l
  UNION ALL SELECT h.* FROM task_history_pod_launch_snapshots h
  WHERE NOT EXISTS (SELECT 1 FROM pod_launch_snapshots l WHERE l.pod_id = h.pod_id);
CREATE TABLE task_history_github_operations AS SELECT * FROM github_operations WHERE 0;
CREATE UNIQUE INDEX task_history_github_operation_identity ON task_history_github_operations(pod_id, operation_key);
CREATE VIEW retained_github_operations AS SELECT l.* FROM github_operations l
  UNION ALL SELECT h.* FROM task_history_github_operations h
  WHERE NOT EXISTS (SELECT 1 FROM github_operations l WHERE l.pod_id = h.pod_id AND l.operation_key = h.operation_key);
CREATE TRIGGER task_history_pod_launch_snapshots_no_update BEFORE UPDATE ON task_history_pod_launch_snapshots
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_pod_launch_snapshots_no_delete BEFORE DELETE ON task_history_pod_launch_snapshots
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_github_operations_no_update BEFORE UPDATE ON task_history_github_operations
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_github_operations_no_delete BEFORE DELETE ON task_history_github_operations
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
