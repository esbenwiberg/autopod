-- @allow-duplicate-columns
-- Repair migration: DBs where 112 was applied as validation_setup_command (before renumber)
-- never got the scheduled_job_templates table. This recreates it idempotently.

CREATE TABLE IF NOT EXISTS scheduled_job_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_job_templates_name
  ON scheduled_job_templates(lower(name));

ALTER TABLE scheduled_jobs
  ADD COLUMN template_id TEXT REFERENCES scheduled_job_templates(id);

WITH ranked AS (
  SELECT
    id,
    name,
    task,
    created_at,
    updated_at,
    COUNT(*) OVER (PARTITION BY lower(name)) AS name_count
  FROM scheduled_jobs
)
INSERT OR IGNORE INTO scheduled_job_templates (id, name, prompt, created_at, updated_at)
SELECT
  'tmpl-' || id,
  CASE
    WHEN name_count = 1 THEN name
    ELSE name || ' (' || substr(id, 1, 8) || ')'
  END,
  task,
  created_at,
  updated_at
FROM ranked;

UPDATE scheduled_jobs
SET template_id = 'tmpl-' || id
WHERE template_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_template
  ON scheduled_jobs(template_id);
