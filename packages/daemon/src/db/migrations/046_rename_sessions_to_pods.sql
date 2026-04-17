-- Rename the core table from sessions to pods and update all session_id
-- column names in child tables to pod_id.
--
-- SQLite 3.26.0+ automatically updates FK references in child tables when
-- the parent is renamed, so no child-table recreation is required.
-- PRAGMA foreign_keys = OFF is still included so the migration runner
-- suspends FK enforcement during the schema changes.

PRAGMA foreign_keys = OFF;

-- ── Primary table ────────────────────────────────────────────────────────────
ALTER TABLE sessions RENAME TO pods;

-- ── Self-referential FK columns on pods ──────────────────────────────────────
ALTER TABLE pods RENAME COLUMN linked_session_id TO linked_pod_id;
ALTER TABLE pods RENAME COLUMN fix_session_id    TO fix_pod_id;

-- ── Child table: escalations ─────────────────────────────────────────────────
ALTER TABLE escalations RENAME COLUMN session_id TO pod_id;

-- ── Child table: validations ─────────────────────────────────────────────────
ALTER TABLE validations RENAME COLUMN session_id TO pod_id;

-- ── Child table: events ───────────────────────────────────────────────────────
ALTER TABLE events RENAME COLUMN session_id TO pod_id;

-- ── Child table: nudge_messages ───────────────────────────────────────────────
ALTER TABLE nudge_messages RENAME COLUMN session_id TO pod_id;

-- ── Child table: action_audit ─────────────────────────────────────────────────
ALTER TABLE action_audit RENAME COLUMN session_id TO pod_id;

-- ── Child table: task_summaries ───────────────────────────────────────────────
ALTER TABLE task_summaries RENAME COLUMN session_id TO pod_id;

-- ── Child table: pending_validation_overrides ─────────────────────────────────
ALTER TABLE pending_validation_overrides RENAME COLUMN session_id TO pod_id;

-- ── Child table: memory_entries ───────────────────────────────────────────────
ALTER TABLE memory_entries RENAME COLUMN created_by_session_id TO created_by_pod_id;

-- ── Child table: watched_issues ───────────────────────────────────────────────
ALTER TABLE watched_issues RENAME COLUMN session_id TO pod_id;

-- ── Sibling table: scheduled_jobs ────────────────────────────────────────────
ALTER TABLE scheduled_jobs RENAME COLUMN last_session_id TO last_pod_id;
