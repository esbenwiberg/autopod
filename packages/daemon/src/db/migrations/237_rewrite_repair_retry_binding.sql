-- @execute-whole
-- A repair selection is never authorized by an older, generic task retry grant.
ALTER TABLE task_retry_authorizations ADD COLUMN rewrite_repair TEXT
  CHECK (rewrite_repair IS NULL OR (stage='validation' AND json_valid(rewrite_repair)));

-- Also fence unaware consumers of an explicitly targeted grant at the storage boundary.
CREATE TRIGGER rewrite_repair_retry_use BEFORE INSERT ON task_retry_authorization_uses
WHEN EXISTS (
  SELECT 1 FROM task_retry_authorizations a WHERE a.id=NEW.authorization_id
  AND a.rewrite_repair IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM task_retry_attempts t
    JOIN retained_checkpoint_recoveries r ON r.id=json_extract(a.rewrite_repair,'$.recoveryId')
    JOIN retained_continuation_sources s ON s.recovery_id=r.id
    JOIN retained_checkpoint_recovery_events e ON e.recovery_id=r.id AND e.kind='activated'
    JOIN retained_checkpoint_recovery_events c ON c.recovery_id=r.id AND c.kind='checking'
    WHERE t.id=NEW.attempt_id AND t.stage='validation'
      AND t.task_id=a.task_id AND t.pod_id=a.pod_id AND t.previous_failure_id=a.failure_id
      AND r.task_id=t.task_id AND r.pod_id=t.pod_id
      AND t.generation=json_extract(e.evidence,'$.generation')
      AND t.generation=json_extract(c.evidence,'$.generation')
      AND t.generation=json_extract(a.rewrite_repair,'$.generation')
      AND r.request_hash=json_extract(a.rewrite_repair,'$.requestHash')
      AND json_extract(r.binding,'$.configurationHash')=json_extract(a.rewrite_repair,'$.configurationHash')
      AND json_extract(r.binding,'$.approvalRewrite.id')=json_extract(a.rewrite_repair,'$.rewriteId')
      AND json_extract(r.binding,'$.approvalRewrite.dispatchId')=json_extract(a.rewrite_repair,'$.failedDispatchId')
      AND json_extract(s.evidence,'$.head')=json_extract(a.rewrite_repair,'$.candidateHead')
      AND json_extract(s.evidence,'$.tree')=json_extract(a.rewrite_repair,'$.candidateTree')
      AND NOT EXISTS(SELECT 1 FROM retained_checkpoint_recovery_events stopped
        WHERE stopped.recovery_id=r.id AND stopped.kind IN ('blocked','checked'))
  )
)
BEGIN SELECT RAISE(ABORT, 'rewrite repair retry selection mismatch'); END;
CREATE TRIGGER rewrite_repair_retry_no_delete BEFORE DELETE ON task_retry_authorizations
WHEN OLD.rewrite_repair IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'rewrite repair retry authority is retained'); END;
CREATE TRIGGER rewrite_repair_retry_use_no_delete BEFORE DELETE ON task_retry_authorization_uses
WHEN EXISTS(SELECT 1 FROM task_retry_authorizations a WHERE a.id=OLD.authorization_id AND a.rewrite_repair IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'rewrite repair retry use is retained'); END;
