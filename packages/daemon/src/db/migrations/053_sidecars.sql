-- Sidecar infrastructure: per-pod companion containers and per-profile type configs.
-- First consumer: Dagger engine sidecar (Track A of the Dagger support plan).

-- Per-profile sidecar configs as a JSON object, e.g. {"dagger": {"enabled": true, ...}}.
-- NULL = inherit from parent profile.
ALTER TABLE profiles ADD COLUMN sidecars TEXT;

-- Trust gate required before the daemon will spawn a privileged sidecar
-- (currently: Dagger engine). 1 = trusted, 0 = untrusted, NULL = inherit.
ALTER TABLE profiles ADD COLUMN trusted_source INTEGER;

-- Names of sidecars requested at pod creation (e.g. ["dagger"]). JSON array.
-- Persisted so daemon-restart recovery can re-resolve the sidecar spec against
-- the pod's profile and re-spawn the engine.
ALTER TABLE pods ADD COLUMN require_sidecars TEXT;

-- Map of sidecar name → container id for sidecars spawned for this pod.
-- JSON object, e.g. {"dagger": "abc123..."}. NULL / empty when no sidecars requested.
-- Used for teardown cascade and orphan reconciliation on daemon restart.
ALTER TABLE pods ADD COLUMN sidecar_container_ids TEXT;

-- Track B: test-pipeline action config (per-profile). Stored as JSON with
-- { enabled, testRepo, testPipelineId, rateLimitPerHour?, branchPrefix? }.
ALTER TABLE profiles ADD COLUMN test_pipeline TEXT;

-- Track B: branch names the daemon pushed to the test repo for this pod.
-- JSON array. Cleared on pod end so the branch-cleanup sweep can reap them.
ALTER TABLE pods ADD COLUMN test_run_branches TEXT;
