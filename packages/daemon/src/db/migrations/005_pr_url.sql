-- Add PR URL tracking to sessions
ALTER TABLE sessions ADD COLUMN pr_url TEXT DEFAULT NULL;
