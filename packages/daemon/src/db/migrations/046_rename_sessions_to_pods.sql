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

-- ── Child table: session_progress_events ──────────────────────────────────────
ALTER TABLE session_progress_events RENAME COLUMN session_id TO pod_id;

-- ── Child table: pending_validation_overrides ─────────────────────────────────
ALTER TABLE pending_validation_overrides RENAME COLUMN session_id TO pod_id;

-- ── Child table: memory_entries ───────────────────────────────────────────────
-- Needs a full rebuild: the CHECK constraint embeds the 'session' scope literal,
-- which SQLite can only change via table recreation. Also renames the
-- created_by_session_id column in the same pass.
CREATE TABLE memory_entries_new (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global','profile','pod')),
  scope_id TEXT,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  approved INTEGER NOT NULL DEFAULT 0,
  created_by_pod_id TEXT REFERENCES pods(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  rationale TEXT
);

INSERT INTO memory_entries_new (
  id, scope, scope_id, path, content, content_sha256, version, approved,
  created_by_pod_id, created_at, updated_at, rationale
)
SELECT
  id,
  CASE scope WHEN 'session' THEN 'pod' ELSE scope END,
  scope_id, path, content, content_sha256, version, approved,
  created_by_session_id, created_at, updated_at, rationale
FROM memory_entries;

DROP TABLE memory_entries;
ALTER TABLE memory_entries_new RENAME TO memory_entries;
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_entries(scope, scope_id, approved);

-- ── Child table: watched_issues ───────────────────────────────────────────────
ALTER TABLE watched_issues RENAME COLUMN session_id TO pod_id;

-- ── Sibling table: scheduled_jobs ────────────────────────────────────────────
ALTER TABLE scheduled_jobs RENAME COLUMN last_session_id TO last_pod_id;
