-- NOTE: There is a circular FK reference between scheduled_jobs and sessions:
--   scheduled_jobs.last_session_id → sessions.id  (ON DELETE SET NULL — safe)
--   sessions.scheduled_job_id      → scheduled_jobs.id  (see ALTER TABLE below)
-- Both nullable columns with ON DELETE SET NULL / application-level nullify-before-delete
-- (see ScheduledJobRepository.delete()) prevent constraint violations at runtime.
CREATE TABLE scheduled_jobs (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  profile_name     TEXT NOT NULL REFERENCES profiles(name),
  task             TEXT NOT NULL,
  cron_expression  TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  next_run_at      TEXT NOT NULL,
  last_run_at      TEXT,
  last_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  catchup_pending  INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_scheduled_jobs_enabled_next
  ON scheduled_jobs(enabled, next_run_at)
  WHERE catchup_pending = 0;

ALTER TABLE sessions ADD COLUMN scheduled_job_id TEXT REFERENCES scheduled_jobs(id);
CREATE INDEX idx_sessions_scheduled_job ON sessions(scheduled_job_id);
