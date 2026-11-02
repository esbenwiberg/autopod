-- @execute-whole
-- Explicit loss acceptance binds original validation evidence; it is not settlement.
-- Old recovery decisions have no retrospective authority over validation custody.
ALTER TABLE sandbox_recovery_requests ADD COLUMN validation_evidence TEXT
  CHECK(validation_evidence IS NULL OR json_valid(validation_evidence));
CREATE TRIGGER sandbox_recovery_validation_immutable
BEFORE UPDATE OF validation_evidence ON sandbox_recovery_requests
WHEN NEW.validation_evidence IS NOT OLD.validation_evidence
BEGIN SELECT RAISE(ABORT,'Validation abandonment evidence is immutable'); END;
