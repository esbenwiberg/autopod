ALTER TABLE profiles ADD COLUMN pr_provider TEXT NOT NULL DEFAULT 'github';
ALTER TABLE profiles ADD COLUMN ado_pat TEXT;
