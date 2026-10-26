-- @execute-whole
-- Preserve the original uncertain request and record an operator decision separately.
CREATE TABLE merge_operator_recoveries (
  attempt_id TEXT PRIMARY KEY REFERENCES merge_attempts(id),
  intent_id TEXT NOT NULL REFERENCES merge_intents(id),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  recovered_at TEXT NOT NULL
);
CREATE TRIGGER merge_operator_recoveries_immutable BEFORE UPDATE ON merge_operator_recoveries
BEGIN SELECT RAISE(ABORT, 'Merge operator recoveries are immutable'); END;
CREATE TRIGGER merge_operator_recoveries_no_delete BEFORE DELETE ON merge_operator_recoveries
BEGIN SELECT RAISE(ABORT, 'Merge operator recoveries are immutable'); END;
