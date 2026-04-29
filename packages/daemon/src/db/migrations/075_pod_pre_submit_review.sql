-- Cache the verdict from pre_submit_review so the daemon's full reviewer can
-- skip Tier 1 when the diff hasn't changed since the agent's pre-submit pass.
ALTER TABLE pods ADD COLUMN pre_submit_review TEXT;
