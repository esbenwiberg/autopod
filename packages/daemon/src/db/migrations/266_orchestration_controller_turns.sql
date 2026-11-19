-- Host-selected mission, model route and reviewed recipe bindings, frozen on first use.
ALTER TABLE orchestration_runs ADD COLUMN controller_policy_digest TEXT;
CREATE TABLE orchestration_controller_turns (
  run_id TEXT NOT NULL, wait_key TEXT NOT NULL, wake_digest TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','invalid','decided')),
  decision_json TEXT, input_tokens INTEGER, output_tokens INTEGER,
  PRIMARY KEY(run_id,wait_key),
  FOREIGN KEY(run_id,wait_key) REFERENCES orchestration_result_waits(run_id,wait_key)
);
-- Every turn reserves exactly one provider request before I/O, even if its outcome is lost.
CREATE VIEW orchestration_request_balances AS SELECT r.id,
  r.worker_request_limit - COALESCE((SELECT sum(c.reserved_requests) FROM orchestration_continuations c WHERE c.run_id=r.id),0)
  - (SELECT count(*) FROM orchestration_controller_turns t WHERE t.run_id=r.id) AS remaining
  FROM orchestration_runs r;
