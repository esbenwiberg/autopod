-- Original artifact custody is permanent. Results do not authorize delivery/release.
CREATE TABLE artifact_checks_recoveries (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL REFERENCES pods(id),
  task_id TEXT NOT NULL UNIQUE,
  container_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  binding TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE artifact_checks_recovery_events (
  recovery_id TEXT NOT NULL REFERENCES artifact_checks_recoveries(id),
  kind TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recovery_id, kind)
);
