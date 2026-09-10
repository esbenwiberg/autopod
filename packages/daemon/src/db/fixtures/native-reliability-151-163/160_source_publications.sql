-- @execute-whole
CREATE TABLE source_publication_intents (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  pod_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  generation INTEGER NOT NULL,
  source_identity TEXT NOT NULL,
  admitted_at TEXT NOT NULL
);
CREATE TABLE source_publication_receipts (
  intent_id TEXT PRIMARY KEY REFERENCES source_publication_intents(id),
  receipt TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
);
CREATE INDEX source_publications_pod ON source_publication_intents(pod_id, generation, admitted_at);
CREATE TRIGGER source_publication_intents_immutable BEFORE UPDATE ON source_publication_intents
BEGIN SELECT RAISE(ABORT, 'source publication admission is immutable'); END;
CREATE TRIGGER source_publication_receipts_immutable BEFORE UPDATE ON source_publication_receipts
BEGIN SELECT RAISE(ABORT, 'source publication receipt is immutable'); END;
