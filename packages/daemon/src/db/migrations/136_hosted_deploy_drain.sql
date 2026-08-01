-- Prevent hosted deployment restarts from racing newly admitted pods.
CREATE TABLE IF NOT EXISTS hosted_deploy_drain (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  actor_user_id TEXT NOT NULL,
  actor_name TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
