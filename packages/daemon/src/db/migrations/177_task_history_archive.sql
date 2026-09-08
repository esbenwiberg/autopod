-- @execute-whole
-- Raw task history has a lifetime independent of the operator pod list.
-- Mirrors deliberately require matching columns: future source-table migrations
-- must update their history mirror too, or archive preparation fails closed.
CREATE TABLE task_history_deletions (pod_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL);
CREATE TABLE task_history_pods AS SELECT * FROM pods WHERE 0;
CREATE UNIQUE INDEX task_history_pods_identity ON task_history_pods(id);
CREATE VIEW retained_pods AS SELECT l.*, 0 AS history_archived FROM pods l
  UNION ALL SELECT h.*, 1 AS history_archived FROM task_history_pods h
  WHERE NOT EXISTS (SELECT 1 FROM pods l WHERE l.id = h.id);
CREATE TABLE task_history_task_executions AS SELECT * FROM task_executions WHERE 0;
CREATE UNIQUE INDEX task_history_task_executions_identity ON task_history_task_executions(pod_id);
CREATE VIEW retained_task_executions AS SELECT l.* FROM task_executions l
  UNION ALL SELECT h.* FROM task_history_task_executions h
  WHERE NOT EXISTS (SELECT 1 FROM task_executions l WHERE l.pod_id = h.pod_id);
CREATE TABLE task_history_task_agent_runs AS SELECT * FROM task_agent_runs WHERE 0;
CREATE UNIQUE INDEX task_history_task_agent_runs_identity ON task_history_task_agent_runs(id);
CREATE INDEX task_history_task_agent_runs_pod ON task_history_task_agent_runs(pod_id);
CREATE VIEW retained_task_agent_runs AS SELECT l.* FROM task_agent_runs l
  UNION ALL SELECT h.* FROM task_history_task_agent_runs h
  WHERE NOT EXISTS (SELECT 1 FROM task_agent_runs l WHERE l.id = h.id);
CREATE TABLE task_history_provider_attempts AS SELECT * FROM provider_attempts WHERE 0;
CREATE UNIQUE INDEX task_history_provider_attempts_identity ON task_history_provider_attempts(pod_id, ordinal);
CREATE INDEX task_history_provider_attempts_pod ON task_history_provider_attempts(pod_id);
CREATE VIEW retained_provider_attempts AS SELECT l.* FROM provider_attempts l
  UNION ALL SELECT h.* FROM task_history_provider_attempts h
  WHERE NOT EXISTS (SELECT 1 FROM provider_attempts l WHERE l.pod_id = h.pod_id AND l.ordinal = h.ordinal);
CREATE TABLE task_history_provider_attempt_telemetry_corrections AS SELECT * FROM provider_attempt_telemetry_corrections WHERE 0;
CREATE UNIQUE INDEX task_history_provider_attempt_telemetry_corrections_identity ON task_history_provider_attempt_telemetry_corrections(pod_id, ordinal);
CREATE INDEX task_history_provider_attempt_telemetry_corrections_pod ON task_history_provider_attempt_telemetry_corrections(pod_id);
CREATE VIEW retained_provider_attempt_telemetry_corrections AS SELECT l.* FROM provider_attempt_telemetry_corrections l
  UNION ALL SELECT h.* FROM task_history_provider_attempt_telemetry_corrections h
  WHERE NOT EXISTS (SELECT 1 FROM provider_attempt_telemetry_corrections l WHERE l.pod_id = h.pod_id AND l.ordinal = h.ordinal);
CREATE TABLE task_history_validations AS SELECT * FROM validations WHERE 0;
CREATE UNIQUE INDEX task_history_validations_identity ON task_history_validations(id);
CREATE INDEX task_history_validations_pod ON task_history_validations(pod_id);
CREATE VIEW retained_validations AS SELECT l.* FROM validations l
  UNION ALL SELECT h.* FROM task_history_validations h
  WHERE NOT EXISTS (SELECT 1 FROM validations l WHERE l.id = h.id);
CREATE TABLE task_history_validation_phase_evidence AS SELECT * FROM validation_phase_evidence WHERE 0;
CREATE UNIQUE INDEX task_history_validation_phase_evidence_identity ON task_history_validation_phase_evidence(id);
CREATE INDEX task_history_validation_phase_evidence_pod ON task_history_validation_phase_evidence(pod_id);
CREATE VIEW retained_validation_phase_evidence AS SELECT l.* FROM validation_phase_evidence l
  UNION ALL SELECT h.* FROM task_history_validation_phase_evidence h
  WHERE NOT EXISTS (SELECT 1 FROM validation_phase_evidence l WHERE l.id = h.id);
CREATE TABLE task_history_pod_finalizations AS SELECT * FROM pod_finalizations WHERE 0;
CREATE UNIQUE INDEX task_history_pod_finalizations_identity ON task_history_pod_finalizations(pod_id, generation, cycle);
CREATE INDEX task_history_pod_finalizations_pod ON task_history_pod_finalizations(pod_id);
CREATE VIEW retained_pod_finalizations AS SELECT l.* FROM pod_finalizations l
  UNION ALL SELECT h.* FROM task_history_pod_finalizations h
  WHERE NOT EXISTS (SELECT 1 FROM pod_finalizations l WHERE l.pod_id = h.pod_id AND l.generation = h.generation AND l.cycle = h.cycle);
CREATE TABLE task_history_completion_decisions AS SELECT * FROM completion_decisions WHERE 0;
CREATE UNIQUE INDEX task_history_completion_decisions_identity ON task_history_completion_decisions(pod_id, decision_id);
CREATE INDEX task_history_completion_decisions_pod ON task_history_completion_decisions(pod_id);
CREATE VIEW retained_completion_decisions AS SELECT l.* FROM completion_decisions l
  UNION ALL SELECT h.* FROM task_history_completion_decisions h
  WHERE NOT EXISTS (SELECT 1 FROM completion_decisions l WHERE l.pod_id = h.pod_id AND l.decision_id = h.decision_id);
CREATE TABLE task_history_escalations AS SELECT * FROM escalations WHERE 0;
CREATE UNIQUE INDEX task_history_escalations_identity ON task_history_escalations(id);
CREATE INDEX task_history_escalations_pod ON task_history_escalations(pod_id);
CREATE VIEW retained_escalations AS SELECT l.* FROM escalations l
  UNION ALL SELECT h.* FROM task_history_escalations h
  WHERE NOT EXISTS (SELECT 1 FROM escalations l WHERE l.id = h.id);
CREATE TABLE task_history_nudge_messages AS SELECT * FROM nudge_messages WHERE 0;
CREATE UNIQUE INDEX task_history_nudge_messages_identity ON task_history_nudge_messages(id);
CREATE INDEX task_history_nudge_messages_pod ON task_history_nudge_messages(pod_id);
CREATE VIEW retained_nudge_messages AS SELECT l.* FROM nudge_messages l
  UNION ALL SELECT h.* FROM task_history_nudge_messages h
  WHERE NOT EXISTS (SELECT 1 FROM nudge_messages l WHERE l.id = h.id);
CREATE TRIGGER task_history_deletions_no_update BEFORE UPDATE ON task_history_deletions
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_deletions_no_delete BEFORE DELETE ON task_history_deletions
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_pods_no_update BEFORE UPDATE ON task_history_pods
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_pods_no_delete BEFORE DELETE ON task_history_pods
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_task_executions_no_update BEFORE UPDATE ON task_history_task_executions
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_task_executions_no_delete BEFORE DELETE ON task_history_task_executions
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_task_agent_runs_no_update BEFORE UPDATE ON task_history_task_agent_runs
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_task_agent_runs_no_delete BEFORE DELETE ON task_history_task_agent_runs
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_provider_attempts_no_update BEFORE UPDATE ON task_history_provider_attempts
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_provider_attempts_no_delete BEFORE DELETE ON task_history_provider_attempts
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_provider_attempt_telemetry_corrections_no_update BEFORE UPDATE ON task_history_provider_attempt_telemetry_corrections
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_provider_attempt_telemetry_corrections_no_delete BEFORE DELETE ON task_history_provider_attempt_telemetry_corrections
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_validations_no_update BEFORE UPDATE ON task_history_validations
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_validations_no_delete BEFORE DELETE ON task_history_validations
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_validation_phase_evidence_no_update BEFORE UPDATE ON task_history_validation_phase_evidence
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_validation_phase_evidence_no_delete BEFORE DELETE ON task_history_validation_phase_evidence
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_pod_finalizations_no_update BEFORE UPDATE ON task_history_pod_finalizations
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_pod_finalizations_no_delete BEFORE DELETE ON task_history_pod_finalizations
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_completion_decisions_no_update BEFORE UPDATE ON task_history_completion_decisions
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_completion_decisions_no_delete BEFORE DELETE ON task_history_completion_decisions
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_escalations_no_update BEFORE UPDATE ON task_history_escalations
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_escalations_no_delete BEFORE DELETE ON task_history_escalations
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_nudge_messages_no_update BEFORE UPDATE ON task_history_nudge_messages
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER task_history_nudge_messages_no_delete BEFORE DELETE ON task_history_nudge_messages
BEGIN SELECT RAISE(ABORT, 'retained task history is immutable'); END;
CREATE TRIGGER pod_deletion_requires_history BEFORE DELETE ON pods
WHEN NOT EXISTS (SELECT 1 FROM task_history_deletions WHERE pod_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'archive task history before deleting a pod'); END;
CREATE TRIGGER pod_id_history_not_reusable BEFORE INSERT ON pods
WHEN EXISTS (SELECT 1 FROM task_history_deletions WHERE pod_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'pod id has retained task history; create a distinct execution'); END;
DROP TRIGGER task_membership_immutable;
CREATE TRIGGER task_membership_immutable
BEFORE UPDATE OF linked_pod_id ON pods
WHEN NEW.linked_pod_id IS NOT OLD.linked_pod_id
  AND EXISTS (SELECT 1 FROM task_executions WHERE pod_id = OLD.id)
  AND NOT (
    NEW.linked_pod_id IS NULL
    AND EXISTS (SELECT 1 FROM task_history_deletions WHERE pod_id = OLD.linked_pod_id)
    AND EXISTS (
      SELECT 1 FROM task_history_task_executions parent JOIN task_executions child ON child.task_id = parent.task_id
      WHERE parent.pod_id = OLD.linked_pod_id AND child.pod_id = OLD.id AND child.parent_pod_id = OLD.linked_pod_id
    )
  )
BEGIN SELECT RAISE(ABORT, 'task membership is immutable; create a distinct execution'); END;
