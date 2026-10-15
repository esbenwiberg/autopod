CREATE TABLE managed_public_reads (
  pod_id TEXT NOT NULL REFERENCES managed_pods(pod_id),
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  response_json TEXT,
  PRIMARY KEY (pod_id, operation_key)
);
