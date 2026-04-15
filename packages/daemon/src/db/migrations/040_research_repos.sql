ALTER TABLE sessions ADD COLUMN reference_repos TEXT DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN artifacts_path  TEXT DEFAULT NULL;
ALTER TABLE sessions ADD COLUMN reference_repo_pat TEXT DEFAULT NULL;
