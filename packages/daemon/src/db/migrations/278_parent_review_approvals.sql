-- Approval releases a private bundle for review; it is not publication authority.
CREATE TABLE parent_review_approvals (
  run_id TEXT NOT NULL REFERENCES parent_managed_runs(run_id),
  evidence_digest TEXT NOT NULL,
  approval_digest TEXT NOT NULL,
  actor_digest TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,evidence_digest),
  FOREIGN KEY(run_id,evidence_digest) REFERENCES orchestration_checkpoint_custody(run_id,evidence_digest)
);
CREATE TRIGGER parent_review_approval_immutable BEFORE UPDATE ON parent_review_approvals
BEGIN SELECT RAISE(ABORT,'parent review approval is immutable'); END;
CREATE TRIGGER parent_review_approval_retained BEFORE DELETE ON parent_review_approvals
BEGIN SELECT RAISE(ABORT,'parent review approval is retained'); END;
