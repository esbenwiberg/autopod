-- Per-field merge strategy for profile inheritance.
-- When NULL or a key is absent, the historical merge behavior is used.
-- Child profiles can set a key to 'replace' to use only their value and
-- ignore the parent's. See packages/shared/src/types/profile.ts (MergeStrategy).
ALTER TABLE profiles ADD COLUMN merge_strategy TEXT;
