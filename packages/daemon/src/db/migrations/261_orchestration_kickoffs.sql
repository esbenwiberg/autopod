-- Initial host-approved recipe catalog, not a child or a request reservation.
CREATE TABLE orchestration_kickoffs (
  run_id TEXT PRIMARY KEY REFERENCES orchestration_runs(id),
  seed_digest TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  recipes_json TEXT NOT NULL
);
