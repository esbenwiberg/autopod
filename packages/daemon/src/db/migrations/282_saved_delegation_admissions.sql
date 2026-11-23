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

-- A normal Task kill must fence the delegated outbox at the same instant. Keep
-- reservations and receipts; ask the run-scoped watchdog to stop live workers.
CREATE TRIGGER saved_delegation_cancel_on_parent_kill
AFTER UPDATE OF status ON pods
WHEN NEW.status IN ('killing','killed') AND OLD.status IS NOT NEW.status
BEGIN
  UPDATE orchestration_runs SET canceled=1 WHERE id IN (
    SELECT a.run_id FROM saved_delegation_admissions a
    JOIN parent_managed_runs p ON p.run_id=a.run_id WHERE p.pod_id=NEW.id
  );
  UPDATE managed_pods SET revoked=1,stop_requested=1 WHERE observed_exit=0
    AND dispatcher_installation_id IN (
      SELECT 'native.'||a.run_id FROM saved_delegation_admissions a
      JOIN parent_managed_runs p ON p.run_id=a.run_id WHERE p.pod_id=NEW.id
    );
END;
