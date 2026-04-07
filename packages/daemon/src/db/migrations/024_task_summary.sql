-- Task summary: agent-reported summary of what was done + any deviations from plan
ALTER TABLE sessions ADD COLUMN task_summary TEXT DEFAULT NULL;

-- Progress event history: full sequence of phase transitions (previously only latest was kept)
CREATE TABLE IF NOT EXISTS session_progress_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  description TEXT NOT NULL,
  current_phase INTEGER NOT NULL,
  total_phases INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_progress_events_session ON session_progress_events(session_id);
