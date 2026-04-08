-- Add merge_block_reason column for tracking why a PR merge is pending
ALTER TABLE sessions ADD COLUMN merge_block_reason TEXT DEFAULT NULL;
