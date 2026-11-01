-- Fleet visibility only. Rows and all original resources/evidence remain owned.
-- No cascading FK: visibility history survives later, separately qualified deletion.
CREATE TABLE pod_fleet_archives (
  pod_id TEXT PRIMARY KEY,
  archived_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  restored_at TEXT
);
