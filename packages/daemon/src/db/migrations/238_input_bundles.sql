-- Bounded input bytes are included in the existing transactional SQLite backup.
-- References intentionally outlive pod deletion and container cleanup.
CREATE TABLE input_bundles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  manifest TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uploading', 'sealed')),
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, request_key)
);
CREATE TABLE input_bundle_files (
  bundle_id TEXT NOT NULL REFERENCES input_bundles(id) ON DELETE CASCADE,
  file_index INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY(bundle_id, file_index)
);
CREATE TABLE pod_input_bundles (
  pod_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL REFERENCES input_bundles(id),
  PRIMARY KEY(pod_id, bundle_id)
);
ALTER TABLE pods ADD COLUMN input_bundle TEXT;
ALTER TABLE task_history_pods ADD COLUMN input_bundle TEXT;
CREATE INDEX input_bundles_owner ON input_bundles(owner_id);
CREATE INDEX pod_input_bundles_bundle ON pod_input_bundles(bundle_id);
