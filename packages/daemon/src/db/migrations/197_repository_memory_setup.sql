-- @execute-whole
-- Preserve the setup binding of converted profile memory. Null means repository-wide.
ALTER TABLE memory_entries ADD COLUMN repository_setup_id TEXT;
ALTER TABLE memory_candidates ADD COLUMN repository_setup_id TEXT;
