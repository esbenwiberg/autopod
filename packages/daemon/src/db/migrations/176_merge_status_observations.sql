-- @execute-whole
-- Reversible PR status observations are distinct from immutable merge confirmations.
CREATE TABLE merge_status_observations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id TEXT NOT NULL REFERENCES merge_intents(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('open', 'closed')),
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX merge_status_intent ON merge_status_observations(intent_id, sequence);
CREATE INDEX merge_intents_task ON merge_intents(task_id);
CREATE TRIGGER merge_status_immutable BEFORE UPDATE ON merge_status_observations
BEGIN SELECT RAISE(ABORT, 'PR status observation is immutable'); END;
