-- @execute-whole
CREATE TABLE provider_attempts (
  pod_id TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  provider TEXT NOT NULL,
  provider_account_id TEXT,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  profile_reference TEXT NOT NULL CHECK (
    length(profile_reference) <= 128
    AND profile_reference NOT GLOB '*[[:space:]]*'
  ),
  profile_snapshot TEXT NOT NULL,
  native_session_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT,
  classification_category TEXT,
  classification_definitive INTEGER,
  classification_message TEXT,
  classification_retry_after TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  handoff_reference TEXT,
  PRIMARY KEY (pod_id, ordinal),
  CHECK (
    (ended_at IS NULL AND outcome IS NULL AND classification_category IS NULL
      AND classification_definitive IS NULL AND classification_message IS NULL
      AND classification_retry_after IS NULL)
    OR
    (ended_at IS NOT NULL AND outcome IS NOT NULL)
  ),
  CHECK (
    classification_category IS NULL
    OR classification_category IN (
      'transient', 'quota_exhausted', 'auth', 'provider_unavailable', 'unknown'
    )
  ),
  CHECK (classification_definitive IS NULL OR classification_definitive IN (0, 1)),
  CHECK (
    (classification_category IS NULL AND classification_definitive IS NULL
      AND classification_message IS NULL AND classification_retry_after IS NULL)
    OR
    (classification_category IS NOT NULL AND classification_definitive IS NOT NULL
      AND classification_message IS NOT NULL)
  ),
  CHECK (
    outcome IS NULL OR outcome IN ('completed', 'failed', 'aborted', 'quota_exhausted')
  ),
  CHECK (
    outcome NOT IN ('failed', 'quota_exhausted')
    OR classification_category IS NOT NULL
  )
);

CREATE UNIQUE INDEX provider_attempts_one_active_per_pod
  ON provider_attempts(pod_id)
  WHERE ended_at IS NULL;

CREATE TRIGGER provider_attempts_append_close_only
BEFORE UPDATE ON provider_attempts
WHEN
  OLD.ended_at IS NOT NULL
  OR NEW.pod_id IS NOT OLD.pod_id
  OR NEW.ordinal IS NOT OLD.ordinal
  OR NEW.provider IS NOT OLD.provider
  OR NEW.provider_account_id IS NOT OLD.provider_account_id
  OR NEW.runtime IS NOT OLD.runtime
  OR NEW.model IS NOT OLD.model
  OR NEW.profile_reference IS NOT OLD.profile_reference
  OR NEW.profile_snapshot IS NOT OLD.profile_snapshot
  OR NEW.started_at IS NOT OLD.started_at
  OR (NEW.ended_at IS NULL AND NEW.handoff_reference IS NOT OLD.handoff_reference)
  OR (OLD.native_session_id IS NOT NULL AND NEW.native_session_id IS NOT OLD.native_session_id)
  OR NEW.input_tokens < OLD.input_tokens
  OR NEW.output_tokens < OLD.output_tokens
  OR NEW.cost_usd < OLD.cost_usd
  OR (
    NEW.ended_at IS NOT NULL
    AND (
      NEW.input_tokens IS NOT OLD.input_tokens
      OR NEW.output_tokens IS NOT OLD.output_tokens
      OR NEW.cost_usd IS NOT OLD.cost_usd
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'provider attempts are append/close-only');
END;

CREATE TRIGGER provider_attempts_no_direct_delete
BEFORE DELETE ON provider_attempts
WHEN EXISTS (SELECT 1 FROM pods WHERE id = OLD.pod_id)
BEGIN
  SELECT RAISE(ABORT, 'provider attempts cannot be deleted directly');
END;
