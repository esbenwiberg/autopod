-- At most one automatic pair per signed parent run; a lost send is not replayable.
CREATE TABLE parent_qualification_jobs (
  run_id TEXT PRIMARY KEY REFERENCES parent_managed_runs(run_id),
  selection_json TEXT NOT NULL CHECK(length(selection_json) <= 8192 AND json_valid(selection_json)),
  status TEXT NOT NULL CHECK(status IN ('reserved','checks','independentReview','ready','failed','not-sent','unknown')),
  evidence_digest TEXT,
  CHECK((status='ready')=(evidence_digest IS NOT NULL)),
  FOREIGN KEY(run_id,evidence_digest) REFERENCES orchestration_checkpoint_custody(run_id,evidence_digest)
);
CREATE TRIGGER parent_qualification_selection_immutable
BEFORE UPDATE OF run_id,selection_json ON parent_qualification_jobs
BEGIN SELECT RAISE(ABORT,'parent qualification selection is immutable'); END;
