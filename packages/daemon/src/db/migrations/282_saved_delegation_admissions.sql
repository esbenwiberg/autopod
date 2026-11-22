-- One reviewed launch identity, with retained source custody, per saved-policy Task.
CREATE TABLE saved_delegation_admissions (
  run_id TEXT PRIMARY KEY REFERENCES parent_managed_runs(run_id),
  request_id TEXT NOT NULL UNIQUE,
  owner_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  seed_evidence_digest TEXT NOT NULL,
  FOREIGN KEY (run_id, seed_evidence_digest)
    REFERENCES orchestration_checkpoint_custody(run_id, evidence_digest)
);

CREATE TRIGGER saved_delegation_admission_immutable
BEFORE UPDATE ON saved_delegation_admissions
BEGIN SELECT RAISE(ABORT, 'saved delegation admission is immutable'); END;
CREATE TRIGGER saved_delegation_admission_retained
BEFORE DELETE ON saved_delegation_admissions
BEGIN SELECT RAISE(ABORT, 'saved delegation admission is retained'); END;
