-- @execute-whole
-- A factual external delivery observation is separate from daemon publication
-- and merge intents. Reports remain unpreserved; retain the recovery source.
CREATE TABLE external_delivery_observations (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sandbox_id TEXT NOT NULL,
  receipt TEXT NOT NULL CHECK (json_valid(receipt)),
  UNIQUE(pod_id, generation)
);
CREATE INDEX external_delivery_retained_resource ON external_delivery_observations(sandbox_id);
CREATE TRIGGER external_delivery_no_update BEFORE UPDATE ON external_delivery_observations
BEGIN SELECT RAISE(ABORT, 'external delivery observations are immutable'); END;
CREATE TRIGGER external_delivery_no_delete BEFORE DELETE ON external_delivery_observations
BEGIN SELECT RAISE(ABORT, 'external delivery observations are immutable'); END;
