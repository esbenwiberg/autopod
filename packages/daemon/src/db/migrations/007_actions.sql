-- Action control plane: action policy on profiles, output mode, and audit trail

-- Action policy (JSON: ActionPolicy — enabled groups, overrides, custom actions, sanitization, quarantine)
ALTER TABLE profiles ADD COLUMN action_policy TEXT DEFAULT NULL;

-- Output mode: 'pr' (default, code changes) or 'artifact' (research/output collection)
ALTER TABLE profiles ADD COLUMN output_mode TEXT NOT NULL DEFAULT 'pr';

-- Audit trail for every action execution
CREATE TABLE IF NOT EXISTS action_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action_name TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  response_summary TEXT DEFAULT NULL,
  pii_detected INTEGER NOT NULL DEFAULT 0,
  quarantine_score REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_action_audit_session
  ON action_audit(session_id);

CREATE INDEX IF NOT EXISTS idx_action_audit_action_name
  ON action_audit(action_name);
