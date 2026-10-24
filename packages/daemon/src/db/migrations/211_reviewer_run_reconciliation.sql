-- An operator may close an unmeasured reviewer run. The original 'uncertain' state is retained
-- as evidence, and the reconciliation is recorded alongside it.
ALTER TABLE isolated_reviewer_runs ADD COLUMN reconciled_at TEXT;
ALTER TABLE isolated_reviewer_runs ADD COLUMN reconciled_by TEXT;
ALTER TABLE isolated_reviewer_runs ADD COLUMN reconciliation_note TEXT;
ALTER TABLE isolated_reviewer_runs ADD COLUMN usage_basis TEXT
  CHECK(usage_basis IN ('operator-reported','unknown-accepted'));
