-- @execute-whole
ALTER TABLE task_retry_attempts ADD COLUMN provider_retry_not_before TEXT
  CHECK (provider_retry_not_before IS NULL OR (stage = 'worker'
    AND length(provider_retry_not_before) = 24
    AND substr(provider_retry_not_before, 24) = 'Z'
    AND julianday(provider_retry_not_before) IS NOT NULL));

-- Rollback code must not ignore a recorded provider cooldown or drop it from ancestry.
CREATE TRIGGER worker_retry_deadline_admission BEFORE INSERT ON task_retry_attempts
WHEN NEW.stage = 'worker' AND EXISTS (
  SELECT 1 FROM task_retry_attempts p WHERE p.id = NEW.previous_failure_id
    AND p.stage = 'worker' AND p.binding_hash = NEW.binding_hash
    AND p.provider_retry_not_before IS NOT NULL
    AND (NEW.provider_retry_not_before IS NULL
      OR NEW.provider_retry_not_before < p.provider_retry_not_before
      OR NEW.not_before < p.provider_retry_not_before)
)
BEGIN SELECT RAISE(ABORT, 'worker provider retry deadline cannot be bypassed'); END;

CREATE TRIGGER worker_retry_deadline_monotonic BEFORE UPDATE ON task_retry_attempts
WHEN OLD.provider_retry_not_before IS NOT NULL
  AND (NEW.provider_retry_not_before IS NULL
    OR NEW.provider_retry_not_before < OLD.provider_retry_not_before)
BEGIN SELECT RAISE(ABORT, 'worker provider retry deadline cannot be shortened'); END;
