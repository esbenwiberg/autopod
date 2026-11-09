-- @execute-whole
-- Native session evidence is separate from Codex corrections and original attempt evidence.
CREATE TABLE claude_session_telemetry_receipts (
  pod_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  cost_usd REAL NOT NULL CHECK(cost_usd >= 0),
  binding_hash TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(pod_id,ordinal)
);
CREATE TRIGGER claude_session_telemetry_no_update BEFORE UPDATE ON claude_session_telemetry_receipts
BEGIN SELECT RAISE(ABORT,'Claude telemetry receipts are immutable'); END;
CREATE TRIGGER claude_session_telemetry_no_delete BEFORE DELETE ON claude_session_telemetry_receipts
BEGIN SELECT RAISE(ABORT,'Claude telemetry receipts are retained'); END;
