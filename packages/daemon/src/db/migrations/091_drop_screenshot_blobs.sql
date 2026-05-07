-- Migration 091: Drop legacy base64 screenshot blobs from the validations table.
--
-- Two-part cleanup:
--   1. Strip base64 fields embedded inside the `result` JSON column.
--   2. Drop the dedicated `screenshots` column (now superseded by the on-disk store).
--
-- The runner wraps each .sql file in an implicit transaction so all UPDATEs
-- and the ALTER TABLE are atomic.
--
-- JSON1 correlated-subquery pattern used below requires SQLite ≥ 3.38 (shipped
-- with better-sqlite3 ≥ 9.x which bundles SQLite 3.43+).

-- ── 1a: Strip smoke.pages[].screenshotBase64 ────────────────────────────────
UPDATE validations
SET result = json_set(
  result,
  '$.smoke.pages',
  (
    SELECT json_group_array(json_remove(value, '$.screenshotBase64'))
    FROM json_each(result, '$.smoke.pages')
  )
)
WHERE json_type(result, '$.smoke.pages') = 'array';

-- ── 1b: Strip acValidation.checks[].screenshot ──────────────────────────────
UPDATE validations
SET result = json_set(
  result,
  '$.acValidation.checks',
  (
    SELECT json_group_array(json_remove(value, '$.screenshot'))
    FROM json_each(result, '$.acValidation.checks')
  )
)
WHERE json_type(result, '$.acValidation.checks') = 'array';

-- ── 1c: Remove taskReview.screenshots entirely ───────────────────────────────
-- New code writes ScreenshotRef[] which is serialised into result JSON;
-- legacy rows had string[] blobs here. Drop-on-cutover: set to empty array.
UPDATE validations
SET result = json_set(result, '$.taskReview.screenshots', json('[]'))
WHERE json_type(result, '$.taskReview') = 'object';

-- ── 2: Drop the dedicated screenshots column ─────────────────────────────────
-- The column was NOT NULL DEFAULT '[]' and is not indexed — DROP COLUMN is safe.
ALTER TABLE validations DROP COLUMN screenshots;
