-- @execute-whole
-- Dispatch evidence/accounting can close an intermediate infrastructure attempt
-- without duplicating the caller's one logical validation history/completion event.
CREATE TABLE validation_logical_publications (
  dispatch_id TEXT PRIMARY KEY REFERENCES validation_dispatch_results(dispatch_id),
  result_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER validation_logical_publications_no_update BEFORE UPDATE ON validation_logical_publications
BEGIN SELECT RAISE(ABORT,'Logical validation publication is immutable'); END;
CREATE TRIGGER validation_logical_publications_no_delete BEFORE DELETE ON validation_logical_publications
BEGIN SELECT RAISE(ABORT,'Logical validation publication is immutable'); END;
