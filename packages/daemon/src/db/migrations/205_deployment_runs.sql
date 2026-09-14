-- @execute-whole
CREATE TABLE deployment_runs (
  id TEXT PRIMARY KEY,
  pod_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('awaiting_approval','approved','denied','running','completed','failed','uncertain','reconciled')),
  expires_at TEXT NOT NULL,
  approved_by TEXT,
  container_id TEXT,
  exec_json TEXT,
  receipt_json TEXT,
  reconciliation_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(pod_id,operation_key)
);
CREATE UNIQUE INDEX deployment_target_active ON deployment_runs(target_id) WHERE state IN ('running','uncertain');
CREATE TRIGGER deployment_plan_immutable BEFORE UPDATE OF pod_id,operation_key,owner_id,target_id,plan_digest,plan_json,expires_at,created_at ON deployment_runs
BEGIN SELECT RAISE(ABORT,'Deployment approval identity is immutable'); END;
CREATE TRIGGER deployment_runs_retained BEFORE DELETE ON deployment_runs
BEGIN SELECT RAISE(ABORT,'Deployment effects must be retained'); END;
