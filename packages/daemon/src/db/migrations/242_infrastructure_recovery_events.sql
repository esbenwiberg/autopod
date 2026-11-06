-- @execute-whole
-- Additional capabilities for explicit infrastructure recovery; old checkpoint rows keep old semantics.
CREATE TABLE retained_infrastructure_events (
  recovery_id TEXT NOT NULL REFERENCES retained_checkpoint_recoveries(id),
  kind TEXT NOT NULL CHECK(kind IN ('stop-dispatched','stopped','worker','candidate')),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(recovery_id,kind)
);
CREATE TRIGGER retained_infrastructure_events_no_update BEFORE UPDATE ON retained_infrastructure_events
BEGIN SELECT RAISE(ABORT, 'Infrastructure recovery evidence is immutable'); END;
CREATE TRIGGER retained_infrastructure_events_no_delete BEFORE DELETE ON retained_infrastructure_events
BEGIN SELECT RAISE(ABORT, 'Infrastructure recovery evidence cannot be deleted'); END;
