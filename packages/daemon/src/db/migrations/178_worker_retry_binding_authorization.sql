-- @execute-whole
ALTER TABLE task_retry_authorizations ADD COLUMN target_binding_hash TEXT
  CHECK (target_binding_hash IS NULL OR
    (stage = 'worker' AND length(target_binding_hash) = 64 AND target_binding_hash NOT GLOB '*[^0-9a-f]*'));

-- An older daemon must not consume a target-bound grant for its original binding.
CREATE TRIGGER worker_retry_target_binding_use BEFORE INSERT ON task_retry_authorization_uses
WHEN EXISTS (
  SELECT 1 FROM task_retry_authorizations a
  WHERE a.id = NEW.authorization_id AND a.target_binding_hash IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM task_retry_attempts r
      WHERE r.id = NEW.attempt_id AND r.stage = 'worker'
        AND r.binding_hash = a.target_binding_hash
        AND r.task_id = a.task_id AND r.pod_id = a.pod_id
        AND r.previous_failure_id = a.failure_id
    )
)
BEGIN SELECT RAISE(ABORT, 'worker retry authorization target binding or scope mismatch'); END;
