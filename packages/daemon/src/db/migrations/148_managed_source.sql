CREATE TABLE managed_source_candidates (
  pod_id TEXT PRIMARY KEY REFERENCES managed_pods(pod_id),
  candidate_json TEXT NOT NULL,
  bundle BLOB NOT NULL
);
CREATE TABLE managed_source_operations (
  pod_id TEXT NOT NULL REFERENCES managed_pods(pod_id),
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  request_json TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'reserved',
  receipt_json TEXT,
  PRIMARY KEY(pod_id,operation_key),
  UNIQUE(pod_id)
);
