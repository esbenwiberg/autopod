-- @execute-whole
CREATE TABLE merge_intents (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  publication_id TEXT NOT NULL REFERENCES source_publication_receipts(intent_id),
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  generation INTEGER NOT NULL,
  pr_identity TEXT NOT NULL,
  request TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE merge_attempts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL REFERENCES merge_intents(id),
  admitted_at TEXT NOT NULL
);
CREATE TABLE merge_observations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL REFERENCES merge_attempts(id),
  intent_id TEXT NOT NULL REFERENCES merge_intents(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('pending', 'merged')),
  evidence TEXT NOT NULL CHECK (evidence IN ('merge_response', 'provider_lookup')),
  result TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(attempt_id, disposition)
);
CREATE UNIQUE INDEX merge_confirmation_once ON merge_observations(intent_id) WHERE disposition = 'merged';
CREATE INDEX merge_intents_pod ON merge_intents(pod_id, generation);
CREATE INDEX merge_intents_pr ON merge_intents(pr_identity);
CREATE INDEX merge_attempts_intent ON merge_attempts(intent_id, sequence);
CREATE INDEX merge_observations_intent ON merge_observations(intent_id, sequence);
CREATE TRIGGER merge_intents_immutable BEFORE UPDATE ON merge_intents
BEGIN SELECT RAISE(ABORT, 'merge intent is immutable'); END;
CREATE TRIGGER merge_attempts_immutable BEFORE UPDATE ON merge_attempts
BEGIN SELECT RAISE(ABORT, 'merge admission is immutable'); END;
CREATE TRIGGER merge_observations_immutable BEFORE UPDATE ON merge_observations
BEGIN SELECT RAISE(ABORT, 'merge observation is immutable'); END;
