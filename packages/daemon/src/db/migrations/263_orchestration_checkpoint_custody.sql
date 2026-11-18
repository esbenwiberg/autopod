-- Private verified inputs; never a worker-supplied path, branch or delivery ref.
CREATE TABLE orchestration_checkpoint_custody (
  run_id TEXT NOT NULL REFERENCES orchestration_runs(id),
  evidence_digest TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK(length(manifest) <= 16384),
  bundle BLOB NOT NULL CHECK(length(bundle) BETWEEN 1 AND 67108864),
  PRIMARY KEY(run_id, evidence_digest)
);
