-- Separate bounded gateway journal. Existing managed allowance and native rows retain semantics.
CREATE TABLE managed_provider_requests (
  pod_id TEXT NOT NULL REFERENCES managed_pods(pod_id),
  operation_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  transport_digest TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','observed')),
  response_json TEXT,
  PRIMARY KEY (pod_id, operation_key)
);
