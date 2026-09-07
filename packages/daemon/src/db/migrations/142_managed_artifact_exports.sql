-- Managed outputs are independent of historical pods.artifacts_path.
CREATE TABLE artifact_exports (
    artifact_id TEXT PRIMARY KEY,
    pod_id TEXT NOT NULL UNIQUE,
    dispatcher_attempt_id TEXT NOT NULL,
    execution_spec_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','uploading','committed','failed')),
    manifest_json TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    bundle_sha256 TEXT NOT NULL,
    bundle_bytes BLOB NOT NULL,
    blob_manifest_name TEXT NOT NULL,
    blob_bundle_name TEXT NOT NULL,
    file_count INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    created_at INTEGER NOT NULL,
    committed_at INTEGER,
    receipt_json TEXT
);
