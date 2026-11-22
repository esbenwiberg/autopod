-- @execute-whole
-- No pod FK: exact receipts and their evidence outlive the fleet projection.
CREATE TABLE retained_cleanup_requests (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL UNIQUE,
  request TEXT NOT NULL CHECK (json_valid(request)),
  actor TEXT NOT NULL CHECK (json_valid(actor)),
  binding TEXT NOT NULL CHECK (json_valid(binding)),
  created_at TEXT NOT NULL
);
CREATE TABLE retained_cleanup_targets (
  request_id TEXT NOT NULL REFERENCES retained_cleanup_requests(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('docker_container','docker_bridge','host_worktree','host_prepared_root')),
  identity TEXT NOT NULL,
  namespace TEXT NOT NULL,
  PRIMARY KEY(request_id, ordinal),
  UNIQUE(kind, identity, namespace)
);
CREATE INDEX retained_cleanup_target_identity ON retained_cleanup_targets(kind, identity);
CREATE TABLE retained_cleanup_facts (
  request_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('dispatch','absent')),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(request_id, ordinal, kind),
  FOREIGN KEY(request_id, ordinal) REFERENCES retained_cleanup_targets(request_id, ordinal)
);
CREATE TABLE retained_cleanup_completions (
  request_id TEXT PRIMARY KEY REFERENCES retained_cleanup_requests(id),
  recorded_at TEXT NOT NULL
);
-- These mutable live projections otherwise cascade with the pod; preserve their
-- last existing values without rewriting time, score or billing semantics.
CREATE TABLE retained_cleanup_history_metrics (
  request_id TEXT PRIMARY KEY REFERENCES retained_cleanup_requests(id),
  evidence TEXT NOT NULL CHECK(json_valid(evidence))
);
CREATE TRIGGER retained_cleanup_metrics_no_update BEFORE UPDATE ON retained_cleanup_history_metrics
BEGIN SELECT RAISE(ABORT,'Cleanup history evidence is immutable'); END;
CREATE TRIGGER retained_cleanup_metrics_no_delete BEFORE DELETE ON retained_cleanup_history_metrics
BEGIN SELECT RAISE(ABORT,'Cleanup history evidence is immutable'); END;
CREATE TABLE retained_cleanup_blockers (
  request_id TEXT PRIMARY KEY REFERENCES retained_cleanup_requests(id),
  blocker TEXT NOT NULL CHECK(json_valid(blocker)),
  recorded_at TEXT NOT NULL
);
CREATE VIEW retained_cleanup_held AS SELECT r.* FROM retained_cleanup_requests r
  WHERE NOT EXISTS(SELECT 1 FROM retained_cleanup_completions c WHERE c.request_id=r.id);
CREATE TRIGGER retained_cleanup_request_no_update BEFORE UPDATE ON retained_cleanup_requests
BEGIN SELECT RAISE(ABORT,'Cleanup decision is immutable'); END;
CREATE TRIGGER retained_cleanup_request_no_delete BEFORE DELETE ON retained_cleanup_requests
BEGIN SELECT RAISE(ABORT,'Cleanup decision is immutable'); END;
CREATE TRIGGER retained_cleanup_target_no_update BEFORE UPDATE ON retained_cleanup_targets
BEGIN SELECT RAISE(ABORT,'Cleanup target is immutable'); END;
CREATE TRIGGER retained_cleanup_target_no_delete BEFORE DELETE ON retained_cleanup_targets
BEGIN SELECT RAISE(ABORT,'Cleanup target is immutable'); END;
CREATE TRIGGER retained_cleanup_fact_no_update BEFORE UPDATE ON retained_cleanup_facts
BEGIN SELECT RAISE(ABORT,'Cleanup effect evidence is immutable'); END;
CREATE TRIGGER retained_cleanup_fact_no_delete BEFORE DELETE ON retained_cleanup_facts
BEGIN SELECT RAISE(ABORT,'Cleanup effect evidence is immutable'); END;
CREATE TRIGGER retained_cleanup_completion_no_update BEFORE UPDATE ON retained_cleanup_completions
BEGIN SELECT RAISE(ABORT,'Cleanup completion is immutable'); END;
CREATE TRIGGER retained_cleanup_completion_no_delete BEFORE DELETE ON retained_cleanup_completions
BEGIN SELECT RAISE(ABORT,'Cleanup completion is immutable'); END;

-- Last-line fences for direct SQL writers and stale allocation scopes.
CREATE TRIGGER retained_cleanup_fence_update BEFORE UPDATE ON pods
WHEN EXISTS(SELECT 1 FROM retained_cleanup_held WHERE pod_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this pod'); END;
CREATE TRIGGER retained_cleanup_fence_delete BEFORE DELETE ON pods
WHEN EXISTS(SELECT 1 FROM retained_cleanup_held WHERE pod_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this pod'); END;
CREATE TRIGGER retained_cleanup_fence_pod_insert BEFORE INSERT ON pods
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE pod_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this pod ID'); END;
CREATE TRIGGER retained_cleanup_fence_execution BEFORE INSERT ON task_executions
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task'); END;
CREATE TRIGGER retained_cleanup_fence_allocation BEFORE INSERT ON retained_allocation_attempts
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE task_id=NEW.task_id OR pod_id=NEW.pod_id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this allocation'); END;
CREATE TRIGGER retained_cleanup_fence_pod_insert_claim BEFORE INSERT ON pods
WHEN EXISTS(SELECT 1 FROM retained_cleanup_targets t JOIN retained_cleanup_held h ON h.id=t.request_id
  WHERE (t.kind='docker_container' AND t.identity=NEW.container_id)
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(NEW.worktree_path,t.identity))
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(NEW.recovery_worktree_path,t.identity))
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(NEW.artifacts_path,t.identity)))
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_rebind BEFORE UPDATE OF container_id,worktree_path,recovery_worktree_path,artifacts_path ON pods
WHEN EXISTS(SELECT 1 FROM retained_cleanup_targets t JOIN retained_cleanup_held h ON h.id=t.request_id
  WHERE (t.kind='docker_container' AND t.identity=NEW.container_id)
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(NEW.worktree_path,t.identity))
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(NEW.recovery_worktree_path,t.identity))
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(NEW.artifacts_path,t.identity)))
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_agent_run BEFORE INSERT ON task_agent_runs
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE pod_id=NEW.pod_id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_retry BEFORE INSERT ON task_retry_attempts
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE pod_id=NEW.pod_id OR task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_publication BEFORE INSERT ON source_publication_intents
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE pod_id=NEW.pod_id OR task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_merge BEFORE INSERT ON merge_intents
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE pod_id=NEW.pod_id OR task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_checkpoint BEFORE INSERT ON retained_checkpoint_recoveries
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE pod_id=NEW.pod_id OR task_id=NEW.task_id) OR EXISTS(SELECT 1 FROM retained_cleanup_targets t JOIN retained_cleanup_held h ON h.id=t.request_id
  WHERE (t.kind='docker_container' AND t.identity=NEW.container_id)
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(NEW.worktree_path,t.identity)))
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_checkpoint_events BEFORE INSERT ON retained_checkpoint_recovery_events
WHEN EXISTS(SELECT 1 FROM retained_checkpoint_recoveries r JOIN retained_cleanup_requests h ON h.pod_id=r.pod_id WHERE r.id=NEW.recovery_id)
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_validation BEFORE INSERT ON validation_dispatches
WHEN EXISTS(SELECT 1 FROM retained_cleanup_requests WHERE pod_id=NEW.pod_id OR task_id=NEW.task_id) OR EXISTS(SELECT 1 FROM retained_cleanup_targets t JOIN retained_cleanup_held h ON h.id=t.request_id
  WHERE (t.kind='docker_container' AND t.identity=json_extract(NEW.binding,'$.containerId'))
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(json_extract(NEW.binding,'$.worktreePath'),t.identity)))
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
CREATE TRIGGER retained_cleanup_fence_publication_resource BEFORE INSERT ON source_publication_resources
WHEN EXISTS(SELECT 1 FROM retained_cleanup_targets t JOIN retained_cleanup_held h ON h.id=t.request_id
  WHERE (t.kind='docker_container' AND t.identity=NEW.container_id)
    OR (t.kind IN ('host_worktree','host_prepared_root') AND autopod_paths_overlap(NEW.worktree_path,t.identity)))
BEGIN SELECT RAISE(ABORT,'Retained cleanup owns this task or allocation'); END;
