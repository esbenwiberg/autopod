-- @execute-whole
-- These receipts outlive pod deletion. An unresolved attempt never expires into authority.
CREATE TABLE deletion_cleanup_intents (
  id TEXT PRIMARY KEY, pod_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
  identity TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX deletion_cleanup_task ON deletion_cleanup_intents(task_id);
CREATE TABLE deletion_cleanup_attempts (
  id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES deletion_cleanup_intents(id),
  started_at TEXT NOT NULL, settled_at TEXT
);
CREATE UNIQUE INDEX deletion_cleanup_active ON deletion_cleanup_attempts(intent_id) WHERE settled_at IS NULL;
CREATE TABLE deletion_cleanup_steps (
  intent_id TEXT NOT NULL REFERENCES deletion_cleanup_intents(id),
  name TEXT NOT NULL CHECK(name IN ('preview','sidecars','container','network','test branches','worktree','runtime state')),
  attempt_id TEXT NOT NULL REFERENCES deletion_cleanup_attempts(id), completed_at TEXT NOT NULL,
  PRIMARY KEY(intent_id,name)
);
CREATE TRIGGER deletion_cleanup_identity_immutable BEFORE UPDATE ON deletion_cleanup_intents
WHEN NEW.id IS NOT OLD.id OR NEW.pod_id IS NOT OLD.pod_id OR NEW.task_id IS NOT OLD.task_id
 OR NEW.identity IS NOT OLD.identity OR NEW.created_at IS NOT OLD.created_at
 OR OLD.completed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'deletion cleanup identity is immutable'); END;
CREATE TRIGGER deletion_cleanup_intents_no_delete BEFORE DELETE ON deletion_cleanup_intents
BEGIN SELECT RAISE(ABORT, 'deletion cleanup receipts are retained'); END;
CREATE TRIGGER deletion_cleanup_attempts_immutable BEFORE UPDATE ON deletion_cleanup_attempts
WHEN NEW.id IS NOT OLD.id OR NEW.intent_id IS NOT OLD.intent_id OR NEW.started_at IS NOT OLD.started_at
 OR OLD.settled_at IS NOT NULL OR NEW.settled_at IS NULL
BEGIN SELECT RAISE(ABORT, 'deletion cleanup attempt is immutable'); END;
CREATE TRIGGER deletion_cleanup_attempts_no_delete BEFORE DELETE ON deletion_cleanup_attempts
BEGIN SELECT RAISE(ABORT, 'deletion cleanup receipts are retained'); END;
CREATE TRIGGER deletion_cleanup_steps_no_update BEFORE UPDATE ON deletion_cleanup_steps
BEGIN SELECT RAISE(ABORT, 'deletion cleanup steps are immutable'); END;
CREATE TRIGGER deletion_cleanup_steps_no_delete BEFORE DELETE ON deletion_cleanup_steps
BEGIN SELECT RAISE(ABORT, 'deletion cleanup steps are retained'); END;
CREATE TRIGGER deletion_cleanup_pod_fence BEFORE UPDATE ON pods
WHEN EXISTS (SELECT 1 FROM deletion_cleanup_intents WHERE pod_id=OLD.id AND completed_at IS NULL)
 AND (NEW.status IS NOT OLD.status OR NEW.lifecycle_generation IS NOT OLD.lifecycle_generation
 OR NEW.container_id IS NOT OLD.container_id OR NEW.execution_target IS NOT OLD.execution_target
 OR NEW.worktree_path IS NOT OLD.worktree_path OR NEW.runtime IS NOT OLD.runtime
 OR NEW.profile_name IS NOT OLD.profile_name OR NEW.sidecar_container_ids IS NOT OLD.sidecar_container_ids
 OR NEW.test_run_branches IS NOT OLD.test_run_branches)
BEGIN SELECT RAISE(ABORT, 'pod deletion cleanup ownership is unresolved'); END;
CREATE TRIGGER deletion_cleanup_run_fence BEFORE INSERT ON task_agent_runs
WHEN EXISTS (SELECT 1 FROM deletion_cleanup_intents d JOIN task_executions e ON e.task_id=d.task_id
 WHERE e.pod_id=NEW.pod_id AND d.completed_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'task deletion cleanup ownership is unresolved'); END;
CREATE TRIGGER deletion_cleanup_delete_fence BEFORE DELETE ON pods
WHEN EXISTS (SELECT 1 FROM deletion_cleanup_intents WHERE pod_id=OLD.id AND completed_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'pod deletion cleanup is incomplete'); END;
CREATE TRIGGER deletion_cleanup_completion_guard BEFORE UPDATE OF completed_at ON deletion_cleanup_intents
WHEN NEW.completed_at IS NOT NULL AND
 ((SELECT COUNT(*) FROM deletion_cleanup_steps WHERE intent_id=OLD.id) != 7
 OR EXISTS (SELECT 1 FROM deletion_cleanup_attempts WHERE intent_id=OLD.id AND settled_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'pod deletion cleanup evidence is incomplete'); END;
CREATE TRIGGER deletion_cleanup_intent_admission BEFORE INSERT ON deletion_cleanup_intents
WHEN NOT EXISTS (SELECT 1 FROM task_executions WHERE pod_id=NEW.pod_id AND task_id=NEW.task_id)
 OR EXISTS (SELECT 1 FROM task_agent_runs r JOIN task_executions e ON e.pod_id=r.pod_id
 WHERE e.task_id=NEW.task_id AND r.ended_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'deletion requires settled task execution ownership'); END;
