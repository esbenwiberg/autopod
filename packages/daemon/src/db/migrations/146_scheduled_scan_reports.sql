-- @execute-whole
ALTER TABLE scheduled_jobs ADD COLUMN scan_policy TEXT;
ALTER TABLE scheduled_jobs ADD COLUMN last_report_id TEXT;
CREATE TABLE scheduled_scan_reports (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  run_key TEXT NOT NULL UNIQUE,
  collector_owner TEXT,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'empty_delta', 'complete', 'incomplete')),
  policy TEXT NOT NULL,
  collection TEXT,
  judgment TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX scheduled_scan_reports_job ON scheduled_scan_reports(job_id, created_at);
CREATE TABLE scheduled_scan_findings (
  id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  finding TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'unresolved' CHECK (disposition IN ('unresolved', 'deferred', 'resolved')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE scheduled_scan_occurrences (
  report_id TEXT NOT NULL REFERENCES scheduled_scan_reports(id),
  finding_id TEXT NOT NULL REFERENCES scheduled_scan_findings(id),
  PRIMARY KEY (report_id, finding_id)
);
CREATE TABLE scheduled_scan_triage (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  report_id TEXT NOT NULL REFERENCES scheduled_scan_reports(id),
  finding_ids TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('defer', 'resolve', 'select_repair')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER scheduled_scan_triage_immutable BEFORE UPDATE ON scheduled_scan_triage
BEGIN SELECT RAISE(ABORT, 'scan triage decision is immutable'); END;
CREATE TRIGGER scheduled_scan_report_collection_immutable BEFORE UPDATE OF collection, policy ON scheduled_scan_reports
WHEN OLD.completed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'completed scan collection is immutable'); END;

CREATE TABLE scheduled_scan_repairs (
  selection_id TEXT PRIMARY KEY REFERENCES scheduled_scan_triage(id),
  pod_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TRIGGER scheduled_scan_repairs_immutable BEFORE UPDATE ON scheduled_scan_repairs
BEGIN SELECT RAISE(ABORT, 'scan repair dispatch is immutable'); END;
