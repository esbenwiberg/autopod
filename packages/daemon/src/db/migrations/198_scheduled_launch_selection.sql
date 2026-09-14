-- @detach-legacy-scheduled-profile
-- Retain legacy schedules for explicit conversion. New schedules select a repository and presets.
PRAGMA foreign_keys = OFF;
ALTER TABLE scheduled_jobs ADD COLUMN launch_selection TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN owner_user_id TEXT;
