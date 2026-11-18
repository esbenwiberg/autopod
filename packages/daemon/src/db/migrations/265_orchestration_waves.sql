ALTER TABLE orchestration_runs ADD COLUMN max_active INTEGER NOT NULL DEFAULT 1 CHECK(max_active>0);
ALTER TABLE orchestration_runs ADD COLUMN accepted_evidence TEXT;
ALTER TABLE orchestration_continuations ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'advance' CHECK(operation_kind IN ('advance','spawn'));
UPDATE orchestration_runs AS r SET accepted_evidence=(
  SELECT json_extract(c.checkpoint_json,'$.evidenceDigest') FROM orchestration_continuations c
  WHERE c.run_id=r.id AND json_extract(c.checkpoint_json,'$.commit')=r.accepted_commit
  ORDER BY c.rowid DESC LIMIT 1
);
CREATE TABLE orchestration_child_outcomes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL, start_key TEXT NOT NULL, pod_id TEXT NOT NULL,
  state TEXT NOT NULL, exit_code INTEGER, artifact_id TEXT, candidate_digest TEXT,
  UNIQUE(run_id,start_key), FOREIGN KEY(run_id,start_key) REFERENCES orchestration_continuations(run_id,start_key)
);
CREATE TABLE orchestration_result_waits (
  run_id TEXT NOT NULL REFERENCES orchestration_runs(id), wait_key TEXT NOT NULL,
  after_cursor INTEGER NOT NULL CHECK(after_cursor>=0), minimum INTEGER NOT NULL CHECK(minimum BETWEEN 1 AND 100),
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
  PRIMARY KEY(run_id,wait_key)
);
