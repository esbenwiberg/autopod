CREATE TABLE IF NOT EXISTS pending_validation_overrides (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL,
  description TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('dismiss','guidance')),
  reason TEXT,
  guidance TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pending_overrides_session ON pending_validation_overrides(session_id);
