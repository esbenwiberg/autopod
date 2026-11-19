-- @execute-whole
-- Destructive human disposition, not an abort of preparation or validation settlement.
-- No pod FK: the decision and receipts survive actual pod deletion.
CREATE TABLE approval_rewrite_abandonments (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  binding TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  created_at TEXT NOT NULL
);
CREATE TABLE approval_rewrite_abandonment_events (
  request_id TEXT NOT NULL REFERENCES approval_rewrite_abandonments(id),
  kind TEXT NOT NULL CHECK(kind IN ('dispatch','deleted','worktree-cleaned','complete')),
  resource TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(request_id,kind,resource)
);
CREATE TRIGGER rewrite_abandonment_no_update BEFORE UPDATE ON approval_rewrite_abandonments
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment decisions are immutable'); END;
CREATE TRIGGER rewrite_abandonment_no_delete BEFORE DELETE ON approval_rewrite_abandonments
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment decisions are immutable'); END;
CREATE TRIGGER rewrite_abandonment_event_no_update BEFORE UPDATE ON approval_rewrite_abandonment_events
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment receipts are immutable'); END;
CREATE TRIGGER rewrite_abandonment_event_no_delete BEFORE DELETE ON approval_rewrite_abandonment_events
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment receipts are immutable'); END;
-- Reference-maintenance and telemetry do not grant source/execution authority.
CREATE TRIGGER rewrite_abandonment_pod_fence BEFORE UPDATE OF id,profile_name,task,status,model,runtime,branch,container_id,worktree_path,validation_attempts,max_validation_attempts,last_validation_result,pending_escalation,skip_validation,execution_target,lifecycle_generation,profile_snapshot,agent_mode,output_target,validate,validation_suite,advisory_browser_qa_enabled,promotable,output_mode,start_branch,base_branch,recovery_worktree_path,pr_url,contract,launch_config_digest,provider_account_id_snapshot,provider_id_snapshot,sidecar_container_ids,test_run_branches,validation_waiver,validation_overrides,token_budget,user_id,worktree_compromised ON pods
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments WHERE pod_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment owns this pod permanently'); END;
CREATE TRIGGER rewrite_abandonment_cleanup_fence BEFORE DELETE ON pods
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments WHERE pod_id=OLD.id)
AND NOT EXISTS(SELECT 1 FROM deletion_cleanup_intents WHERE pod_id=OLD.id AND completed_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment requires owned deletion cleanup'); END;

CREATE TRIGGER rewrite_abandonment_pod_tombstone BEFORE INSERT ON pods
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments WHERE pod_id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment pod identity is permanent'); END;

-- Durable reservations prevent another connection from acquiring a selected resource during an await.
CREATE TRIGGER rewrite_abandonment_foreign_pod_insert BEFORE INSERT ON pods
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.resources') r
    WHERE a.pod_id<>NEW.id AND json_extract(r.value,'$.sandboxId')=NEW.container_id)
  OR EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.pathIdentities') p
    WHERE a.pod_id<>NEW.id AND (autopod_paths_overlap(NEW.worktree_path,p.value)
      OR autopod_paths_overlap(NEW.recovery_worktree_path,p.value)))
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment reserves this resource or source path'); END;
CREATE TRIGGER rewrite_abandonment_foreign_pod_update BEFORE UPDATE OF container_id,worktree_path,recovery_worktree_path ON pods
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.resources') r
    WHERE a.pod_id<>NEW.id AND json_extract(r.value,'$.sandboxId')=NEW.container_id)
  OR EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.pathIdentities') p
    WHERE a.pod_id<>NEW.id AND (autopod_paths_overlap(NEW.worktree_path,p.value)
      OR autopod_paths_overlap(NEW.recovery_worktree_path,p.value)))
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment reserves this resource or source path'); END;
CREATE TRIGGER rewrite_abandonment_validation_dispatches_fence BEFORE INSERT ON validation_dispatches
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.resources') r
  WHERE json_extract(r.value,'$.sandboxId')=json_extract(NEW.binding,'$.containerId') AND a.pod_id<>NEW.pod_id)
  OR EXISTS(SELECT 1 FROM approval_rewrite_abandonments WHERE pod_id=NEW.pod_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment reserves this execution resource'); END;
CREATE TRIGGER rewrite_abandonment_approval_source_rewrites_fence BEFORE INSERT ON approval_source_rewrites
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.resources') r
  WHERE json_extract(r.value,'$.sandboxId')=json_extract(NEW.binding,'$.containerId') AND a.pod_id<>NEW.pod_id)
  OR EXISTS(SELECT 1 FROM approval_rewrite_abandonments WHERE pod_id=NEW.pod_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment reserves this execution resource'); END;
CREATE TRIGGER rewrite_abandonment_sandbox_wakeup_intents_fence BEFORE INSERT ON sandbox_wakeup_intents
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.resources') r
  WHERE json_extract(r.value,'$.sandboxId')=NEW.sandbox_id AND a.pod_id<>NEW.pod_id)
  OR EXISTS(SELECT 1 FROM approval_rewrite_abandonments WHERE pod_id=NEW.pod_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment reserves this execution resource'); END;
CREATE TRIGGER rewrite_abandonment_sandbox_recovery_requests_fence BEFORE INSERT ON sandbox_recovery_requests
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.resources') r
  WHERE json_extract(r.value,'$.sandboxId')=NEW.sandbox_id AND a.pod_id<>NEW.pod_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment reserves this execution resource'); END;
CREATE TRIGGER rewrite_abandonment_task_agent_runs_admission BEFORE INSERT ON task_agent_runs
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a JOIN task_executions e ON e.pod_id=a.pod_id
  WHERE a.pod_id=NEW.pod_id OR e.task_id=(SELECT task_id FROM task_executions WHERE pod_id=NEW.pod_id))
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment forbids new execution or delivery'); END;
CREATE TRIGGER rewrite_abandonment_task_retry_attempts_admission BEFORE INSERT ON task_retry_attempts
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a JOIN task_executions e ON e.pod_id=a.pod_id
  WHERE a.pod_id=NEW.pod_id OR e.task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment forbids new execution or delivery'); END;
CREATE TRIGGER rewrite_abandonment_source_publication_intents_admission BEFORE INSERT ON source_publication_intents
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a JOIN task_executions e ON e.pod_id=a.pod_id
  WHERE a.pod_id=NEW.pod_id OR e.task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment forbids new execution or delivery'); END;
CREATE TRIGGER rewrite_abandonment_merge_intents_admission BEFORE INSERT ON merge_intents
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a JOIN task_executions e ON e.pod_id=a.pod_id
  WHERE a.pod_id=NEW.pod_id OR e.task_id=NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment forbids new execution or delivery'); END;
CREATE TRIGGER rewrite_abandonment_rewrite_event_fence BEFORE INSERT ON approval_source_rewrite_events
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a JOIN approval_source_rewrites r ON r.pod_id=a.pod_id WHERE r.id=NEW.rewrite_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment owns immutable rewrite history'); END;
CREATE TRIGGER rewrite_abandonment_resource_publication_fence BEFORE INSERT ON source_publication_resources
WHEN EXISTS(SELECT 1 FROM approval_rewrite_abandonments a,json_each(a.snapshot,'$.resources') r WHERE json_extract(r.value,'$.sandboxId')=NEW.container_id)
BEGIN SELECT RAISE(ABORT, 'rewrite abandonment forbids publication of a selected resource'); END;
