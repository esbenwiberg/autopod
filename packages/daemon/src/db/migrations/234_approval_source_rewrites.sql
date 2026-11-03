-- @execute-whole
-- A source rewrite is not a boolean force-push permission. Preserve the exact
-- predecessor, isolated candidate and checks across process loss.
CREATE TABLE approval_source_rewrites (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  binding TEXT NOT NULL CHECK(json_valid(binding)),
  created_at TEXT NOT NULL
);
CREATE INDEX approval_source_rewrite_pod ON approval_source_rewrites(pod_id, generation);
CREATE TABLE approval_source_rewrite_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  rewrite_id TEXT NOT NULL REFERENCES approval_source_rewrites(id),
  kind TEXT NOT NULL CHECK(kind IN ('prepared','activated','checked','aborted')),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  created_at TEXT NOT NULL,
  UNIQUE(rewrite_id, kind)
);
CREATE TRIGGER approval_rewrite_no_update BEFORE UPDATE ON approval_source_rewrites
BEGIN SELECT RAISE(ABORT, 'approval rewrite bindings are immutable'); END;
CREATE TRIGGER approval_rewrite_no_delete BEFORE DELETE ON approval_source_rewrites
BEGIN SELECT RAISE(ABORT, 'approval rewrite bindings are immutable'); END;
CREATE TRIGGER approval_rewrite_event_no_update BEFORE UPDATE ON approval_source_rewrite_events
BEGIN SELECT RAISE(ABORT, 'approval rewrite evidence is immutable'); END;
CREATE TRIGGER approval_rewrite_event_no_delete BEFORE DELETE ON approval_source_rewrite_events
BEGIN SELECT RAISE(ABORT, 'approval rewrite evidence is immutable'); END;
