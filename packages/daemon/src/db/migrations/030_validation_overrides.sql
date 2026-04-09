-- Human-reviewed validation overrides (dismiss/guidance) for recurring findings.
-- JSON array of ValidationOverride objects, null when no overrides exist.
ALTER TABLE sessions ADD COLUMN validation_overrides TEXT;
