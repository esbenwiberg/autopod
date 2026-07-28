-- @execute-whole
ALTER TABLE provider_attempts
  ADD COLUMN pre_submit_review_runs INTEGER NOT NULL DEFAULT 0
  CHECK (pre_submit_review_runs >= 0);

DROP TRIGGER provider_attempts_append_close_only;

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
  OR NEW.pre_submit_review_runs < OLD.pre_submit_review_runs
  OR (
    NEW.ended_at IS NOT NULL
    AND (
      NEW.input_tokens IS NOT OLD.input_tokens
      OR NEW.output_tokens IS NOT OLD.output_tokens
      OR NEW.cost_usd IS NOT OLD.cost_usd
      OR NEW.pre_submit_review_runs IS NOT OLD.pre_submit_review_runs
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'provider attempts are append/close-only');
END;
