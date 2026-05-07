-- Safety events: one row per guardrail-fire pattern hit across all untrusted-input sources.
-- Covers fleet-wide PII and injection detections (ADR-018).
-- pod_id is NULL for pre-creation detections (e.g. POST /pods free-text, issue-watcher
-- before createSession resolves). Those rows aggregate under __pre_creation__ in analytics.

CREATE TABLE IF NOT EXISTS safety_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id          TEXT    NULL,                      -- NULL for pre-creation detections
  source          TEXT    NOT NULL,                  -- enum: action_response | mcp_proxy | issue_body | claude_md_section | skill_content | pod_input | event_payload
  kind            TEXT    NOT NULL,                  -- 'pii' | 'injection'
  pattern_name    TEXT    NOT NULL,                  -- one row per pattern hit
  severity        REAL    NULL,                      -- 0..1 for injection rows, NULL for pii rows
  payload_excerpt TEXT    NULL,                      -- <= 256 chars, post-sanitize text
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now'))
);

CREATE INDEX IF NOT EXISTS idx_safety_events_created_at ON safety_events(created_at);
CREATE INDEX IF NOT EXISTS idx_safety_events_kind_created_at ON safety_events(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_safety_events_pod_id ON safety_events(pod_id);
