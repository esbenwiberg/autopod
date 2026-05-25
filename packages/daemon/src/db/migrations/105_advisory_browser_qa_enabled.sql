ALTER TABLE profiles ADD COLUMN advisory_browser_qa_enabled INTEGER;
ALTER TABLE pods ADD COLUMN advisory_browser_qa_enabled INTEGER NOT NULL DEFAULT 0;
