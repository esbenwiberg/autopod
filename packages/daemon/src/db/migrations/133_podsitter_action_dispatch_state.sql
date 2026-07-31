-- Track the non-transactional dispatch boundary separately from reservation so restart
-- recovery can safely resume reserved work and fail closed on an unknown dispatch outcome.
ALTER TABLE podsitter_action_audit
  ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'reserved'
  CHECK (dispatch_state IN ('reserved', 'dispatching', 'completed'));

ALTER TABLE podsitter_action_audit
  ADD COLUMN dispatch_started_at TEXT;

-- Preserve terminal state for rows written before this migration.
UPDATE podsitter_action_audit
SET dispatch_state = 'completed'
WHERE completed_at IS NOT NULL;
