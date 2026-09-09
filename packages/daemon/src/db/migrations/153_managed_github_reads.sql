CREATE TABLE IF NOT EXISTS managed_github_reads (
  pod_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  response_json TEXT,
  PRIMARY KEY (pod_id, operation_key),
  FOREIGN KEY (pod_id) REFERENCES managed_pods(pod_id)
);
