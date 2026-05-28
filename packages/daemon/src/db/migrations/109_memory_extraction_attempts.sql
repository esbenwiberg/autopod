CREATE TABLE IF NOT EXISTS memory_extraction_attempts (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  profile_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'candidate_created',
    'below_threshold',
    'reviewer_unavailable',
    'reviewer_failed',
    'invalid_response',
    'no_candidate',
    'skipped'
  )),
  reason TEXT NOT NULL,
  score REAL,
  signals TEXT NOT NULL DEFAULT '[]',
  candidate_id TEXT REFERENCES memory_candidates(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_extraction_attempts_pod
  ON memory_extraction_attempts (pod_id);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_attempts_profile
  ON memory_extraction_attempts (profile_name, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_attempts_status
  ON memory_extraction_attempts (status);
