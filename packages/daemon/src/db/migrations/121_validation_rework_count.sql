-- Scope validation records to the rework they belong to.
--
-- Attempt numbers reset to 1 on every manual rework (pod-manager resets
-- validationAttempts to 0), but validation rows were never scoped per-rework.
-- Readiness picked the highest-attempt row across ALL reworks, so a stale
-- high-numbered failure from an earlier rework beat the fresh low-numbered
-- pass from the current rework. Stamping rework_count lets readiness select
-- only the current rework's latest attempt.
--
-- Existing rows default to 0. Pods mid-rework (rework_count > 0) will have no
-- scoped rows until their next validation, so readiness falls back to the
-- pod-level lastValidationResult, which is already correct.
ALTER TABLE validations ADD COLUMN rework_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_validations_pod_rework ON validations(pod_id, rework_count, attempt);
