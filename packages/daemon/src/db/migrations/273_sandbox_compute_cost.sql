CREATE TABLE sandbox_compute_cost (
  resource_key TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  pod_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  settled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sandbox_compute_cost_pod ON sandbox_compute_cost(pod_id);
CREATE INDEX sandbox_compute_cost_live ON sandbox_compute_cost(settled);
