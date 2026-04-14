CREATE TABLE scheduled_jobs (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  profile_name     TEXT NOT NULL REFERENCES profiles(name),
  task             TEXT NOT NULL,
  cron_expression  TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_run_at      TEXT NOT NULL,
  last_run_at      TEXT,
  last_session_id  TEXT REFERENCES sessions(id),
  catchup_pending  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_scheduled_jobs_enabled_next
  ON scheduled_jobs(enabled, next_run_at)
  WHERE catchup_pending = 0;

ALTER TABLE sessions ADD COLUMN scheduled_job_id TEXT REFERENCES scheduled_jobs(id);
CREATE INDEX idx_sessions_scheduled_job ON sessions(scheduled_job_id);
