PRAGMA foreign_keys = OFF;
CREATE TABLE memory_entries_repository_scope (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global','profile','repository','pod')),
  scope_id TEXT,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  approved INTEGER NOT NULL DEFAULT 0,
  created_by_pod_id TEXT REFERENCES pods(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  rationale TEXT,
  kind TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  applies_when TEXT,
  avoid_when TEXT,
  confidence REAL,
  source_evidence TEXT NOT NULL DEFAULT '[]',
  impact_summary TEXT
);
INSERT INTO memory_entries_repository_scope SELECT * FROM memory_entries;
DROP TABLE memory_entries;
ALTER TABLE memory_entries_repository_scope RENAME TO memory_entries;
CREATE INDEX idx_memory_scope ON memory_entries(scope, scope_id, approved);
PRAGMA foreign_keys = ON;
