-- @execute-whole
CREATE TABLE task_retry_policies (
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  stage TEXT NOT NULL,
  version INTEGER NOT NULL,
  backoffs TEXT NOT NULL,
  PRIMARY KEY (task_id, stage)
);
CREATE TABLE task_retry_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  pod_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  stage TEXT NOT NULL,
  identity TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  retry_kind TEXT CHECK (retry_kind IN ('transient', 'changed_conditions', 'override')),
  previous_failure_id TEXT REFERENCES task_retry_attempts(id),
  admitted_at TEXT NOT NULL,
  not_before TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  outcome TEXT CHECK (outcome IN ('pass', 'nonretryable', 'transient', 'cancelled', 'unknown')),
  measured_duration_ms INTEGER
);
CREATE INDEX task_retry_attempts_task_stage ON task_retry_attempts(task_id, stage, admitted_at);
CREATE UNIQUE INDEX task_retry_one_active ON task_retry_attempts(task_id, stage) WHERE ended_at IS NULL;
CREATE TABLE task_retry_authorizations (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES logical_tasks(id),
  pod_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  failure_id TEXT NOT NULL REFERENCES task_retry_attempts(id),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE task_retry_authorization_uses (
  authorization_id TEXT PRIMARY KEY REFERENCES task_retry_authorizations(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES task_retry_attempts(id)
);
CREATE TRIGGER task_retry_policy_immutable BEFORE UPDATE ON task_retry_policies
BEGIN SELECT RAISE(ABORT, 'task retry policy is immutable'); END;
CREATE TRIGGER task_retry_authorization_immutable BEFORE UPDATE ON task_retry_authorizations
BEGIN SELECT RAISE(ABORT, 'task retry authorization is immutable'); END;
CREATE TRIGGER task_retry_use_immutable BEFORE UPDATE ON task_retry_authorization_uses
BEGIN SELECT RAISE(ABORT, 'task retry authorization use is immutable'); END;
CREATE TRIGGER task_retry_attempt_identity_immutable BEFORE UPDATE ON task_retry_attempts
WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id
 OR NEW.pod_id IS NOT OLD.pod_id OR NEW.execution_id IS NOT OLD.execution_id
 OR NEW.generation IS NOT OLD.generation OR NEW.stage IS NOT OLD.stage
 OR NEW.identity IS NOT OLD.identity OR NEW.binding_hash IS NOT OLD.binding_hash
 OR NEW.retry_kind IS NOT OLD.retry_kind OR NEW.previous_failure_id IS NOT OLD.previous_failure_id
 OR NEW.admitted_at IS NOT OLD.admitted_at OR NEW.not_before IS NOT OLD.not_before
 OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
BEGIN SELECT RAISE(ABORT, 'task retry attempt identity and settlement are immutable'); END;
