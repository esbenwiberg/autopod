-- Fix-pod spawn cooldown: records when the last fix pod was spawned for a parent pod.
-- The daemon enforces a minimum 10-minute interval between fix-pod spawns per parent,
-- preventing a rapidly-failing CI from exhausting fix attempts in a single burst.
ALTER TABLE pods ADD COLUMN last_fix_pod_spawned_at TEXT DEFAULT NULL;
