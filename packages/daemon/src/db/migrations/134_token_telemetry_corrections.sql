-- @execute-whole
-- Preserve original provider-attempt evidence while allowing audited telemetry repairs.
ALTER TABLE pods ADD COLUMN token_telemetry_accuracy TEXT NOT NULL DEFAULT 'partial'
  CHECK (token_telemetry_accuracy IN ('complete', 'partial', 'repaired'));

CREATE TABLE provider_attempt_telemetry_corrections (
  pod_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL CHECK (cost_usd >= 0),
  source TEXT NOT NULL CHECK (source IN ('codex_rollout')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  corrected_at TEXT NOT NULL,
  PRIMARY KEY (pod_id, ordinal),
  FOREIGN KEY (pod_id, ordinal) REFERENCES provider_attempts(pod_id, ordinal) ON DELETE CASCADE
);

CREATE TABLE token_telemetry_repair_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'apply')),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  repaired_pods INTEGER NOT NULL DEFAULT 0,
  partial_pods INTEGER NOT NULL DEFAULT 0,
  skipped_pods INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL
);

CREATE INDEX idx_telemetry_corrections_pod
  ON provider_attempt_telemetry_corrections(pod_id);

CREATE TRIGGER provider_attempt_telemetry_corrections_append_only_update
BEFORE UPDATE ON provider_attempt_telemetry_corrections
BEGIN
  SELECT RAISE(ABORT, 'telemetry corrections are append-only');
END;
