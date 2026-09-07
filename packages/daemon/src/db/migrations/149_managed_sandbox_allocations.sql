CREATE TABLE managed_sandbox_allocations (
  pod_id TEXT PRIMARY KEY,
  spec_digest TEXT NOT NULL,
  sandbox_id TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('creating','created','ready'))
);
