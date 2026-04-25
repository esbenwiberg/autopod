ALTER TABLE profiles ADD COLUMN lint_command TEXT;
ALTER TABLE profiles ADD COLUMN lint_timeout INTEGER;
ALTER TABLE profiles ADD COLUMN sast_command TEXT;
ALTER TABLE profiles ADD COLUMN sast_timeout INTEGER;
