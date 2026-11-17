-- @execute-whole
-- Operator-approved finite reviewer admission ceilings. Measured usage is never reset.
CREATE TABLE pod_reviewer_budget_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  authority_hash TEXT NOT NULL CHECK(length(authority_hash)=64),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  generation INTEGER NOT NULL CHECK(generation>0),
  frozen_limit INTEGER NOT NULL CHECK(frozen_limit>=0),
  previous_limit INTEGER NOT NULL CHECK(previous_limit>=frozen_limit),
  new_limit INTEGER NOT NULL CHECK(new_limit>previous_limit),
  recorded_tokens INTEGER NOT NULL CHECK(recorded_tokens>=0 AND recorded_tokens<new_limit),
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash)=64),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  actor_id TEXT NOT NULL CHECK(length(actor_id)>0),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 10 AND 2000),
  created_at TEXT NOT NULL,
  UNIQUE(pod_id,request_id)
);
CREATE INDEX reviewer_budget_latest ON pod_reviewer_budget_revisions(pod_id,authority_hash,id);
CREATE TRIGGER reviewer_budget_no_update BEFORE UPDATE ON pod_reviewer_budget_revisions
BEGIN SELECT RAISE(ABORT,'Reviewer budget revisions are immutable'); END;
CREATE TRIGGER reviewer_budget_no_delete BEFORE DELETE ON pod_reviewer_budget_revisions
BEGIN SELECT RAISE(ABORT,'Reviewer budget revisions are retained'); END;
ALTER TABLE isolated_reviewer_runs ADD COLUMN reviewer_budget_revision_id INTEGER
  REFERENCES pod_reviewer_budget_revisions(id);
-- Approval promises retained cumulative usage. Preserve measured amounts, scope,
-- and run identity from that point onward, including late finish/reconcile calls.
-- Tasks without a top-up retain their pre-existing accounting behavior.
CREATE TRIGGER approved_reviewer_usage_retained
BEFORE UPDATE OF input_tokens,output_tokens,pod_id,id ON isolated_reviewer_runs
WHEN EXISTS(SELECT 1 FROM pod_reviewer_budget_revisions r WHERE r.pod_id=OLD.pod_id)
AND (NEW.pod_id IS NOT OLD.pod_id OR NEW.id IS NOT OLD.id
  OR (OLD.input_tokens IS NOT NULL AND (NEW.input_tokens IS NULL OR NEW.input_tokens<OLD.input_tokens))
  OR (OLD.output_tokens IS NOT NULL AND (NEW.output_tokens IS NULL OR NEW.output_tokens<OLD.output_tokens)))
BEGIN SELECT RAISE(ABORT,'Approved reviewer measured usage and scope are retained'); END;
CREATE TRIGGER approved_reviewer_usage_delete_retained
BEFORE DELETE ON isolated_reviewer_runs
WHEN EXISTS(SELECT 1 FROM pod_reviewer_budget_revisions r WHERE r.pod_id=OLD.pod_id)
BEGIN SELECT RAISE(ABORT,'Approved reviewer measured usage is retained'); END;

CREATE TRIGGER reviewer_budget_run_binding_immutable
BEFORE UPDATE OF reviewer_budget_revision_id ON isolated_reviewer_runs
WHEN NEW.reviewer_budget_revision_id IS NOT OLD.reviewer_budget_revision_id
BEGIN SELECT RAISE(ABORT,'Reviewer admission budget binding is immutable'); END;
