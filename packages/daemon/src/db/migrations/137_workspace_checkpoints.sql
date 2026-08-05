CREATE TABLE IF NOT EXISTS workspace_checkpoints (
  pod_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  verified_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pod_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_workspace_checkpoints_latest
  ON workspace_checkpoints (pod_id, sequence DESC);
