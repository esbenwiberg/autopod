-- Profile-level issue watcher configuration
ALTER TABLE profiles ADD COLUMN issue_watcher_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN issue_watcher_label_prefix TEXT NOT NULL DEFAULT 'autopod';

-- Tracking table for issues picked up by the watcher (deduplication + lifecycle)
CREATE TABLE IF NOT EXISTS watched_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_name TEXT NOT NULL REFERENCES profiles(name) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  issue_url TEXT NOT NULL,
  issue_title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  trigger_label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, issue_id, profile_name)
);

CREATE INDEX idx_watched_issues_status ON watched_issues(status);
CREATE INDEX idx_watched_issues_session ON watched_issues(session_id);
