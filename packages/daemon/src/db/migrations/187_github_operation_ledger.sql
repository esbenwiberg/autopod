CREATE TABLE github_operations (
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  operation TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  snapshot_rule_id TEXT NOT NULL,
  ceiling_rule_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','sending','succeeded','failed','uncertain')),
  receipt TEXT CHECK (receipt IS NULL OR json_valid(receipt)),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pod_id, operation_key)
);
CREATE INDEX github_operations_unfinished ON github_operations(state, updated_at);
