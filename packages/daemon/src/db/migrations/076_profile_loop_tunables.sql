-- Per-profile overrides for the PR-merge polling cadence and PR-fix-pod
-- cooldown. NULL means "use the daemon default" (60s and 600s respectively).
ALTER TABLE profiles ADD COLUMN merge_poll_interval_sec INTEGER;
ALTER TABLE profiles ADD COLUMN fix_pod_cooldown_sec INTEGER;
