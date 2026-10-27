-- @execute-whole
-- A human may extend a published branch before merging it. Record that external
-- outcome separately: it is not confirmation of our original exact-SHA request.
CREATE TABLE merge_external_observations (
  intent_id TEXT PRIMARY KEY REFERENCES merge_intents(id),
  evidence TEXT NOT NULL CHECK (evidence = 'provider_ancestry'),
  result TEXT NOT NULL,
  ancestry TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TRIGGER merge_external_observations_immutable BEFORE UPDATE ON merge_external_observations
BEGIN SELECT RAISE(ABORT, 'External merge evidence is immutable'); END;
