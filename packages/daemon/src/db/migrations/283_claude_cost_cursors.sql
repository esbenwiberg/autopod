CREATE TABLE claude_cost_cursors (
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  cumulative_cost_usd REAL NOT NULL CHECK (cumulative_cost_usd >= 0),
  PRIMARY KEY (pod_id, session_id)
);
