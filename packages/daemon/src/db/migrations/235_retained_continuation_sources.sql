-- @execute-whole
-- A human-selected repaired candidate does not rewrite its retained predecessor.
CREATE TABLE retained_continuation_sources (
  recovery_id TEXT PRIMARY KEY REFERENCES retained_checkpoint_recoveries(id),
  request_hash TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER retained_continuation_sources_no_update
BEFORE UPDATE ON retained_continuation_sources
BEGIN SELECT RAISE(ABORT, 'Retained continuation source selection is immutable'); END;
CREATE TRIGGER retained_continuation_sources_no_delete
BEFORE DELETE ON retained_continuation_sources
BEGIN SELECT RAISE(ABORT, 'Retained continuation source selection cannot be deleted'); END;
