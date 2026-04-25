-- Security scan layer: per-profile policy + audit tables for scan runs.
-- Profiles get an optional JSON-encoded `security_scan` field. Each scan run
-- writes one row to `security_scans` plus N rows to `security_scan_findings`.

ALTER TABLE profiles ADD COLUMN security_scan TEXT;

CREATE TABLE security_scans (
  id              TEXT PRIMARY KEY,
  pod_id          TEXT NOT NULL,
  checkpoint      TEXT NOT NULL,
  decision        TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER NOT NULL,
  files_scanned   INTEGER NOT NULL,
  files_skipped   INTEGER NOT NULL,
  scan_incomplete INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE security_scan_findings (
  id          TEXT PRIMARY KEY,
  scan_id     TEXT NOT NULL REFERENCES security_scans(id) ON DELETE CASCADE,
  detector    TEXT NOT NULL,
  severity    TEXT NOT NULL,
  file        TEXT NOT NULL,
  line        INTEGER,
  rule_id     TEXT,
  confidence  REAL,
  snippet     TEXT NOT NULL
);

CREATE INDEX idx_security_scans_pod ON security_scans(pod_id);
CREATE INDEX idx_security_scan_findings_scan ON security_scan_findings(scan_id);
