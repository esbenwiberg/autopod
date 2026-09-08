-- @execute-whole
-- Provider disposition can be observed before this intent admitted any request.
-- This is source evidence, not attribution of who performed the merge.
CREATE TABLE merge_disposition_observations (
  intent_id TEXT PRIMARY KEY REFERENCES merge_intents(id),
  disposition TEXT NOT NULL CHECK (disposition = 'merged'),
  evidence TEXT NOT NULL CHECK (evidence = 'provider_lookup'),
  result TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TRIGGER merge_disposition_immutable BEFORE UPDATE ON merge_disposition_observations
BEGIN SELECT RAISE(ABORT, 'merge disposition is immutable'); END;
