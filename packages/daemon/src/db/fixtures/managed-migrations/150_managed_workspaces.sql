CREATE TABLE managed_workspaces (
  pod_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  spec_digest TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  local_path TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved',
  PRIMARY KEY(pod_id,repository_id)
);
