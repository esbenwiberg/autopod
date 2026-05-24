-- @allow-duplicate-columns
-- Extend memory entries with structured metadata and add candidate/usage tables.
-- Legacy rows survive: new columns default to NULL / '[]' / 1 (version).

ALTER TABLE memory_entries ADD COLUMN kind TEXT;
ALTER TABLE memory_entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_entries ADD COLUMN applies_when TEXT;
ALTER TABLE memory_entries ADD COLUMN avoid_when TEXT;
ALTER TABLE memory_entries ADD COLUMN confidence REAL;
ALTER TABLE memory_entries ADD COLUMN source_evidence TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memory_entries ADD COLUMN impact_summary TEXT;

-- Pending durable memory proposals from the daemon reviewer model.
-- Profile-scoped only in v1. Status values: pending, approved, rejected.
CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('create', 'update')),
  target_memory_id TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
  scope TEXT NOT NULL DEFAULT 'profile',
  scope_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  rationale TEXT NOT NULL,
  kind TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  applies_when TEXT,
  avoid_when TEXT,
  confidence REAL NOT NULL,
  source_evidence TEXT NOT NULL DEFAULT '[]',
  impact_summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by_pod_id TEXT NOT NULL,
  fallback_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Usage events: selected, injected, read, searched, plan_reported, summary_reported, not_reported
CREATE TABLE IF NOT EXISTS memory_usage_events (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  pod_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'selected', 'injected', 'read', 'searched',
    'plan_reported', 'summary_reported', 'not_reported'
  )),
  outcome TEXT CHECK (outcome IN ('intended', 'applied', 'not_applicable', 'harmful_stale')),
  reason TEXT,
  relevance_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates (status);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope ON memory_candidates (scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_pod ON memory_candidates (created_by_pod_id);
CREATE INDEX IF NOT EXISTS idx_memory_usage_memory ON memory_usage_events (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_usage_pod ON memory_usage_events (pod_id);
CREATE INDEX IF NOT EXISTS idx_memory_usage_kind ON memory_usage_events (kind);
