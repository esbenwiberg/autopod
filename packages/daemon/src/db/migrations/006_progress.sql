-- Agent plan, progress tracking, nudge message queue, and session ID persistence

-- Plan reported by agent (JSON: { summary, steps })
ALTER TABLE sessions ADD COLUMN plan TEXT DEFAULT NULL;

-- Latest progress reported by agent (JSON: { phase, description, currentPhase, totalPhases })
ALTER TABLE sessions ADD COLUMN progress TEXT DEFAULT NULL;

-- Claude CLI session ID for pause/resume (persisted so daemon restart doesn't lose it)
ALTER TABLE sessions ADD COLUMN claude_session_id TEXT DEFAULT NULL;

-- Nudge message queue: soft messages queued for running agents
CREATE TABLE IF NOT EXISTS nudge_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_nudge_messages_session_pending
  ON nudge_messages(session_id, consumed) WHERE consumed = 0;
