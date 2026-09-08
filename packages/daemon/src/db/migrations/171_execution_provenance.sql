-- @execute-whole
CREATE TABLE execution_provenance (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX execution_provenance_execution ON execution_provenance(execution_id, checked_at);
CREATE TRIGGER execution_provenance_immutable BEFORE UPDATE ON execution_provenance
BEGIN SELECT RAISE(ABORT, 'execution provenance is immutable'); END;
