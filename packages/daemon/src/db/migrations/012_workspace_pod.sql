ALTER TABLE sessions ADD COLUMN output_mode TEXT NOT NULL DEFAULT 'pr';
ALTER TABLE sessions ADD COLUMN base_branch TEXT;
ALTER TABLE sessions ADD COLUMN ac_from TEXT;
