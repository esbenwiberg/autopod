-- Track PR fix retry loop state on sessions
ALTER TABLE sessions ADD COLUMN pr_fix_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN max_pr_fix_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE sessions ADD COLUMN fix_session_id TEXT REFERENCES sessions(id);
