-- @allow-duplicate-columns
-- Repair for 053_sidecars.sql: an earlier revision of 053 only added a subset
-- of its ALTER TABLE statements before being applied on some dev DBs. Because
-- the migration version was recorded as 53, the later-added ALTERs never ran.
-- Re-assert them here. On fresh DBs where 053 applied fully, these would
-- normally error as "duplicate column" but the @allow-duplicate-columns
-- marker in migrate.ts makes the runner skip them.

ALTER TABLE pods ADD COLUMN require_sidecars TEXT;
ALTER TABLE pods ADD COLUMN test_run_branches TEXT;
ALTER TABLE profiles ADD COLUMN test_pipeline TEXT;
