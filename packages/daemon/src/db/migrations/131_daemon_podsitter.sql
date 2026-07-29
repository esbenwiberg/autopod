CREATE TABLE podsitter_config (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  activation TEXT NOT NULL,
  authorized_until TEXT,
  profile_scope TEXT,
  provider_account_id TEXT REFERENCES provider_accounts(id) ON DELETE RESTRICT,
  runtime TEXT,
  model TEXT,
  reasoning_effort TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  budgets TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (provider_account_id IS NULL AND runtime IS NULL AND model IS NULL AND reasoning_effort IS NULL)
    OR (provider_account_id IS NOT NULL AND runtime IS NOT NULL AND model IS NOT NULL)
  )
);

CREATE TABLE podsitter_attention (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  state TEXT NOT NULL,
  failure_signature TEXT,
  decision_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE(pod_id, signature)
);
CREATE INDEX idx_podsitter_attention_current
  ON podsitter_attention(pod_id, state, last_seen_at);

CREATE TABLE podsitter_decisions (
  id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL UNIQUE REFERENCES podsitter_attention(id) ON DELETE CASCADE,
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  attention_signature TEXT NOT NULL,
  configuration_generation INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_version INTEGER NOT NULL,
  -- Keep the account id as immutable audit provenance without retaining the account itself.
  provider_account_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning_effort TEXT,
  decision TEXT,
  outcome TEXT NOT NULL,
  failure_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  executed_at TEXT
);

CREATE TABLE podsitter_action_audit (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL UNIQUE REFERENCES podsitter_decisions(id) ON DELETE CASCADE,
  failure_signature TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  arguments TEXT NOT NULL,
  policy_result TEXT NOT NULL,
  daemon_result TEXT,
  reserved_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE podsitter_provider_state (
  provider_account_id TEXT PRIMARY KEY REFERENCES provider_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  retry_at TEXT,
  reset_at TEXT,
  sanitized_reason TEXT,
  probe_lease_owner TEXT,
  probe_lease_expires_at TEXT,
  recovered_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE system_sandbox_runs (
  id TEXT PRIMARY KEY,
  decision_id TEXT REFERENCES podsitter_decisions(id) ON DELETE SET NULL,
  backend TEXT NOT NULL,
  container_id TEXT,
  outcome TEXT NOT NULL,
  cleanup_state TEXT NOT NULL,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);
