-- @execute-whole
-- #646: the pod owner's audited decision to count a failed provider attempt's
-- usage as unmeasured so a configured failover can continue. Append-only.
-- No pod FK: the receipt and its original evidence outlive the fleet projection.
CREATE TABLE unmeasured_usage_acceptances (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  provider_attempt_ordinal INTEGER NOT NULL CHECK (provider_attempt_ordinal > 0),
  task_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL,
  accepted_by TEXT NOT NULL CHECK (length(trim(accepted_by)) > 0),
  authorization_basis TEXT NOT NULL CHECK (authorization_basis = 'pod_owner'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 2000),
  prior_accuracy TEXT NOT NULL,
  recorded_input_tokens INTEGER NOT NULL CHECK (recorded_input_tokens >= 0),
  recorded_output_tokens INTEGER NOT NULL CHECK (recorded_output_tokens >= 0),
  recorded_cost_usd REAL NOT NULL CHECK (recorded_cost_usd >= 0),
  accepted_at TEXT NOT NULL,
  UNIQUE (pod_id, provider_attempt_ordinal)
);

CREATE INDEX idx_unmeasured_usage_acceptances_pod ON unmeasured_usage_acceptances(pod_id);

CREATE TRIGGER unmeasured_usage_acceptances_append_only_update
BEFORE UPDATE ON unmeasured_usage_acceptances
BEGIN
  SELECT RAISE(ABORT, 'unmeasured usage acceptances are append-only');
END;

CREATE TRIGGER unmeasured_usage_acceptances_append_only_delete
BEFORE DELETE ON unmeasured_usage_acceptances
BEGIN
  SELECT RAISE(ABORT, 'unmeasured usage acceptances are append-only');
END;
