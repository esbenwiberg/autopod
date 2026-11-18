-- @execute-whole
-- Preparation is an immutable document, never an execution or queue admission.
CREATE TABLE fresh_handoff_preparations (
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK(json_valid(receipt)),
  archive_path TEXT,
  PRIMARY KEY(pod_id,generation)
);
CREATE TRIGGER fresh_handoff_preparations_no_update BEFORE UPDATE ON fresh_handoff_preparations
BEGIN SELECT RAISE(ABORT,'handoff preparation is immutable'); END;
CREATE TRIGGER fresh_handoff_preparations_no_delete BEFORE DELETE ON fresh_handoff_preparations
BEGIN SELECT RAISE(ABORT,'handoff preparation is retained'); END;
