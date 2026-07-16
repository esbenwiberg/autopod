-- @allow-duplicate-columns
-- Repair environments where a different migration already claimed version 121,
-- causing 121_pod_failure_reason.sql to be skipped permanently.
ALTER TABLE pods ADD COLUMN failure_reason TEXT;
