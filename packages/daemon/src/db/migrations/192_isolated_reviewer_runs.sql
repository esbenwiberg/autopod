-- Retain inference and cleanup evidence independently of pod/history retention.
CREATE TABLE isolated_reviewer_runs (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL,
  configuration_digest TEXT NOT NULL,
  account_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  execution_target TEXT NOT NULL,
  container_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('preparing','running','completed','failed','uncertain')),
  cleanup TEXT NOT NULL CHECK(cleanup IN ('pending','clean','uncertain')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX isolated_reviewers_pod ON isolated_reviewer_runs(pod_id);
