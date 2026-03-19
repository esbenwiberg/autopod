ALTER TABLE sessions ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'local';
ALTER TABLE profiles ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'local';
