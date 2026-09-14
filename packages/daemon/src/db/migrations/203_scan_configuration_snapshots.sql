-- @execute-whole
CREATE TABLE scheduled_scan_configuration (
  report_id TEXT PRIMARY KEY REFERENCES scheduled_scan_reports(id),
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER scheduled_scan_configuration_no_update BEFORE UPDATE ON scheduled_scan_configuration
BEGIN SELECT RAISE(ABORT, 'Scan configuration is immutable'); END;
CREATE TRIGGER scheduled_scan_configuration_no_delete BEFORE DELETE ON scheduled_scan_configuration
BEGIN SELECT RAISE(ABORT, 'Scan configuration is immutable'); END;
