-- Parent-only custody must not grant the legacy source broker delivery authority.
ALTER TABLE parent_managed_requests ADD COLUMN private_scope_json TEXT;
CREATE TABLE parent_private_collection_claims (
  pod_id TEXT PRIMARY KEY REFERENCES managed_pods(pod_id)
);
CREATE TABLE parent_private_candidates (
  pod_id TEXT PRIMARY KEY REFERENCES managed_pods(pod_id),
  candidate_json TEXT NOT NULL,
  bundle BLOB NOT NULL,
  scope_digest TEXT NOT NULL,
  tree TEXT NOT NULL,
  binding_digest TEXT NOT NULL
);
