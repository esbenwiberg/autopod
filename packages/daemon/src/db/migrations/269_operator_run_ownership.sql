-- Authority survives loss of a checkpoint. Never infer an owner from a run ID or a report.
ALTER TABLE orchestration_runs ADD COLUMN operator_owned INTEGER NOT NULL DEFAULT 0 CHECK(operator_owned IN (0,1));
UPDATE orchestration_runs SET operator_owned=1 WHERE EXISTS (
 SELECT 1 FROM orchestration_checkpoint_custody c WHERE c.run_id=orchestration_runs.id
 AND json_extract(c.manifest,'$.origin')='operator-enrollment/v1'
);
