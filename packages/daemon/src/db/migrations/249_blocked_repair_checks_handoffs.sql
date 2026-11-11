-- @execute-whole
-- Explicit checks-only succession of a settled, source-preserved blocked repair.
-- Originals and their failed evidence remain immutable and resource-retained.
CREATE TABLE retained_blocked_repair_handoffs (
  predecessor_id TEXT PRIMARY KEY REFERENCES retained_checkpoint_recoveries(id),
  successor_id TEXT NOT NULL UNIQUE REFERENCES retained_checkpoint_recoveries(id),
  predecessor_hash TEXT NOT NULL CHECK(length(predecessor_hash)=64),
  created_at TEXT NOT NULL,
  CHECK(predecessor_id != successor_id)
);
CREATE TRIGGER retained_blocked_repair_handoffs_no_update
BEFORE UPDATE ON retained_blocked_repair_handoffs
BEGIN SELECT RAISE(ABORT, 'Blocked repair handoffs are immutable'); END;
CREATE TRIGGER retained_blocked_repair_handoffs_no_delete
BEFORE DELETE ON retained_blocked_repair_handoffs
BEGIN SELECT RAISE(ABORT, 'Blocked repair handoffs are retained'); END;
