-- @execute-whole
-- Append-only execution phases retain the original launch and the same pod identity.
-- No cascading FK: phase evidence must survive removal from the active pod list.
CREATE TABLE pod_launch_phases (
  pod_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  parent_digest TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(pod_id,digest)
);
CREATE TRIGGER pod_launch_phases_no_update BEFORE UPDATE ON pod_launch_phases
BEGIN SELECT RAISE(ABORT, 'launch phase history is immutable'); END;
CREATE TRIGGER pod_launch_phases_no_delete BEFORE DELETE ON pod_launch_phases
BEGIN SELECT RAISE(ABORT, 'launch phase history is immutable'); END;
