CREATE TABLE managed_inputs (
  pod_id TEXT NOT NULL REFERENCES managed_pods(pod_id),
  input_name TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  mount_path TEXT NOT NULL,
  local_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','ready')),
  PRIMARY KEY(pod_id,input_name)
);
