-- Operator budget changes retain the original launch and accounting evidence.
CREATE TABLE task_budget_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  pod_id TEXT NOT NULL,
  previous_budget INTEGER,
  token_budget INTEGER CHECK(token_budget IS NULL OR token_budget > 0),
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX task_budget_changes_latest ON task_budget_changes(task_id, sequence DESC);
