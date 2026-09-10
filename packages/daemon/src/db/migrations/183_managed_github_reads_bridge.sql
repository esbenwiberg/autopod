-- Earlier unpublished native candidates reached 182 before main introduced 153.
-- Execute the authoritative idempotent definition for those databases as well.
CREATE TABLE IF NOT EXISTS managed_github_reads (
  pod_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  response_json TEXT,
  PRIMARY KEY (pod_id, operation_key),
  FOREIGN KEY (pod_id) REFERENCES managed_pods(pod_id)
);

-- Record 153 only after its definition has executed. Fresh managed databases
-- already have this row and keep their original application timestamp.
INSERT OR IGNORE INTO schema_version(version) VALUES (153);
