-- @execute-whole
-- An invocation claim is NOT a worker/validation dispatch or usage receipt.
-- It prevents replaying an entire source-check workflow after lost transport/restart.
CREATE TABLE source_check_invocations (
  adoption_id TEXT PRIMARY KEY REFERENCES source_adoptions(id),
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  claimed_at TEXT NOT NULL
);
CREATE TRIGGER source_check_invocation_no_update BEFORE UPDATE ON source_check_invocations
BEGIN SELECT RAISE(ABORT,'Source check invocation custody is immutable'); END;
CREATE TRIGGER source_check_invocation_no_delete BEFORE DELETE ON source_check_invocations
BEGIN SELECT RAISE(ABORT,'Source check invocation custody is immutable'); END;
