-- @execute-whole
-- Source/check-bound human decisions are independent of mutable readiness projections.
CREATE TABLE recovery_fork_delivery_evidence (
  operation_id TEXT NOT NULL REFERENCES recovery_forks(id),
  kind TEXT NOT NULL CHECK(kind IN ('checks','approval')),
  identity TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,kind,identity)
);
CREATE TRIGGER recovery_fork_delivery_no_update BEFORE UPDATE ON recovery_fork_delivery_evidence
BEGIN SELECT RAISE(ABORT,'Recovery delivery evidence is immutable'); END;
CREATE TRIGGER recovery_fork_delivery_no_delete BEFORE DELETE ON recovery_fork_delivery_evidence
BEGIN SELECT RAISE(ABORT,'Recovery delivery evidence is permanent'); END;
