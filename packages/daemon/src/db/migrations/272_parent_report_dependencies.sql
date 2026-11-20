-- These verified report selectors are evidence, not input artifacts or source authority.
-- The existing immutable request trigger also protects this column.
ALTER TABLE parent_managed_requests
  ADD COLUMN report_dependencies_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(report_dependencies_json) AND json_type(report_dependencies_json) = 'array');
