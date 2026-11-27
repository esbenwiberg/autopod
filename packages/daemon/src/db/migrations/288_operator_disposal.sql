-- Acceptance is separate from physical completion and historical pod status.
CREATE TABLE operator_disposal_intents (
  pod_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  generation INTEGER NOT NULL,
  task_id TEXT,
  request TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (pod_id, request_key)
);
CREATE TABLE operator_disposal_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  pod_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  evidence TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (pod_id, request_key) REFERENCES operator_disposal_intents(pod_id, request_key)
);
