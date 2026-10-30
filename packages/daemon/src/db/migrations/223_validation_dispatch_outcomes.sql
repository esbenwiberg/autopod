-- @execute-whole
-- Preserve the engine-returned result before closing admission or collecting reports.
-- This evidence is separate from the later decorated/published result and proves
-- neither an observed exit nor passing checks when its own failure is unverified.
CREATE TABLE validation_dispatch_outcomes (
  dispatch_id TEXT PRIMARY KEY REFERENCES validation_dispatches(id),
  result_hash TEXT NOT NULL,
  result TEXT NOT NULL CHECK(json_valid(result))
);
CREATE TRIGGER validation_outcomes_no_update BEFORE UPDATE ON validation_dispatch_outcomes
BEGIN SELECT RAISE(ABORT,'Validation execution outcome is immutable'); END;
CREATE TRIGGER validation_outcomes_no_delete BEFORE DELETE ON validation_dispatch_outcomes
BEGIN SELECT RAISE(ABORT,'Validation execution outcome is immutable'); END;
