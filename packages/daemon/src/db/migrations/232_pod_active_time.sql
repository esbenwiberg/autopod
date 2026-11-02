-- @execute-whole
-- State time, not CPU or billed time. Do not backfill unknown historical intervals.
CREATE TABLE pod_active_time (
  pod_id TEXT PRIMARY KEY REFERENCES pods(id) ON DELETE CASCADE,
  elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
  active_since TEXT
);

CREATE TRIGGER pod_active_time_insert AFTER INSERT ON pods
BEGIN
  INSERT INTO pod_active_time (pod_id, active_since)
  VALUES (NEW.id, CASE WHEN NEW.status IN ('running', 'validating')
    THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END);
END;

-- Account in the same transaction as every status transition, including recovery.
-- Repeated status writes and unrelated heartbeat updates must not reset the clock.
CREATE TRIGGER pod_active_time_transition AFTER UPDATE OF status ON pods
WHEN NEW.status IS NOT OLD.status
BEGIN
  UPDATE pod_active_time SET
    elapsed_ms = elapsed_ms + CASE WHEN active_since IS NOT NULL
      THEN MAX(0, CAST(ROUND((julianday('now') - julianday(active_since)) * 86400000) AS INTEGER))
      ELSE 0 END,
    active_since = CASE WHEN NEW.status IN ('running', 'validating')
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
  WHERE pod_id = NEW.id;
END;
