-- Separate from findings receipts: these bytes confer no completion or recovery authority.
CREATE TABLE pod_partial_research_reports (
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  content BLOB,
  sha256 TEXT,
  unavailable_reason TEXT,
  CHECK (
    (content IS NOT NULL AND sha256 IS NOT NULL AND unavailable_reason IS NULL) OR
    (content IS NULL AND sha256 IS NULL AND unavailable_reason IS NOT NULL)
  ),
  CHECK (length(content) <= 5242880),
  PRIMARY KEY (pod_id, generation, cycle),
  FOREIGN KEY (pod_id, generation, cycle)
    REFERENCES pod_finalizations(pod_id, generation, cycle) ON DELETE CASCADE
);
