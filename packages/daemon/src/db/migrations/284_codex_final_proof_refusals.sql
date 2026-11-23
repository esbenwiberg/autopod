-- @execute-whole
-- A refusal is not process settlement, a worker result, or accounting repair.
CREATE TABLE codex_final_proof_refusals (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN (
    'missing_session','missing_rollout','missing_response','missing_terminal',
    'missing_aggregate','aggregate_mismatch','sequence_mismatch',
    'invalid_metadata','snapshot_unavailable','timeout'
  ))
);
CREATE INDEX codex_final_proof_task ON codex_final_proof_refusals(task_id);
CREATE TRIGGER codex_final_proof_no_update BEFORE UPDATE ON codex_final_proof_refusals
BEGIN SELECT RAISE(ABORT,'Codex final proof refusal is immutable'); END;
CREATE TRIGGER codex_final_proof_no_delete BEFORE DELETE ON codex_final_proof_refusals
BEGIN SELECT RAISE(ABORT,'Codex final proof refusal is immutable'); END;
