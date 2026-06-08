ALTER TABLE scheduled_job_templates
  ADD COLUMN fields TEXT NOT NULL DEFAULT '[]';

ALTER TABLE scheduled_jobs
  ADD COLUMN field_values TEXT NOT NULL DEFAULT '{}';
