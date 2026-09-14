-- One review request may consume only its own ordered, frozen failover route.
ALTER TABLE isolated_reviewer_runs ADD COLUMN request_id TEXT;
ALTER TABLE isolated_reviewer_runs ADD COLUMN ordinal INTEGER;
ALTER TABLE isolated_reviewer_runs ADD COLUMN failure_kind TEXT;
CREATE UNIQUE INDEX isolated_reviewer_request_attempt ON isolated_reviewer_runs(request_id,ordinal)
  WHERE request_id IS NOT NULL;
