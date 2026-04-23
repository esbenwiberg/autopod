-- Persisted per-pod behavioural quality scores.
--
-- One row is written on terminal-state (pod.completed) by the quality-score
-- recorder. The score is a 0..100 blend of the QualitySignals plus a bonus
-- for making it to `complete` vs `killed`. Denormalised `runtime`, `profile_name`,
-- and `model` columns exist so leaderboards and drift queries don't need to
-- re-join `pods` (useful once a pod's `model` column is later overwritten by
-- a fix-pod re-run, for example).

CREATE TABLE IF NOT EXISTS pod_quality_scores (
  pod_id TEXT PRIMARY KEY REFERENCES pods(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  read_count INTEGER NOT NULL DEFAULT 0,
  edit_count INTEGER NOT NULL DEFAULT 0,
  read_edit_ratio REAL NOT NULL DEFAULT 0,
  edits_without_prior_read INTEGER NOT NULL DEFAULT 0,
  user_interrupts INTEGER NOT NULL DEFAULT 0,
  tells_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  runtime TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  model TEXT,
  final_status TEXT NOT NULL CHECK(final_status IN ('complete', 'killed')),
  completed_at TEXT NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pqs_computed_at
  ON pod_quality_scores(computed_at);

CREATE INDEX IF NOT EXISTS idx_pqs_runtime_model
  ON pod_quality_scores(runtime, model, computed_at);

CREATE INDEX IF NOT EXISTS idx_pqs_profile
  ON pod_quality_scores(profile_name, computed_at);
