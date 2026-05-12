-- Creates the pending_fix_feedback table for the single-fix-pod design
-- and drops deprecated profile columns that the new queue-based approach replaces.

CREATE TABLE pending_fix_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_pending_fix_feedback_pod_id
  ON pending_fix_feedback(pod_id, created_at);

ALTER TABLE profiles DROP COLUMN reuse_fix_pod;
ALTER TABLE profiles DROP COLUMN fix_pod_cooldown_sec;
