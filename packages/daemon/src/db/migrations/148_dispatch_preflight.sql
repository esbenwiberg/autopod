-- @execute-whole
CREATE TABLE execution_dispatch_bindings (
  execution_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TRIGGER execution_dispatch_binding_immutable BEFORE UPDATE ON execution_dispatch_bindings
BEGIN SELECT RAISE(ABORT, 'dispatch request binding is immutable'); END;
CREATE TABLE execution_rerun_intents (
  execution_id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  source_pod_id TEXT NOT NULL,
  source_execution_id TEXT NOT NULL,
  source_repository TEXT NOT NULL,
  source_base_branch TEXT NOT NULL,
  work_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE UNIQUE INDEX execution_rerun_request ON execution_rerun_intents(user_id,request_key);
CREATE TABLE execution_dispatch_preflights (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  version INTEGER NOT NULL,
  repository TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL,
  work_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted','review_required')),
  conflicts TEXT NOT NULL,
  rerun_intent TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX execution_preflight_identity ON execution_dispatch_preflights(repository, base_branch, work_hash, checked_at);
CREATE INDEX execution_preflight_execution ON execution_dispatch_preflights(execution_id, checked_at);
CREATE TRIGGER execution_rerun_immutable BEFORE UPDATE ON execution_rerun_intents
BEGIN SELECT RAISE(ABORT, 'intentional rerun decision is immutable'); END;
CREATE TRIGGER execution_preflight_immutable BEFORE UPDATE ON execution_dispatch_preflights
BEGIN SELECT RAISE(ABORT, 'dispatch preflight evidence is immutable'); END;
