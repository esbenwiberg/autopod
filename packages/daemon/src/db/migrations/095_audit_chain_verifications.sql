-- Audit chain verifications: append-only log of fleet-wide hash-chain verification runs.
-- Written by POST /audit-chain/verify (Brief 05) and read by GET /pods/analytics/safety
-- to surface the latest verification result in the Safety drill widget.

CREATE TABLE IF NOT EXISTS audit_chain_verifications (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at                   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  total_pods               INTEGER NOT NULL,
  total_entries            INTEGER NOT NULL,
  valid                    INTEGER NOT NULL,        -- 0 | 1
  first_mismatch_pod_id    TEXT    NULL,
  first_mismatch_row_id    INTEGER NULL,
  first_mismatch_reason    TEXT    NULL
);
