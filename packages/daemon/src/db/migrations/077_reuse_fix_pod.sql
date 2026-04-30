-- Long-lived fix pod: when set on a profile, the daemon reuses a single fix
-- pod entity per parent PR across all CI / review feedback rounds instead of
-- spawning a new child pod each round. fix_iteration counts the rounds so the
-- agent and the UI can display "iteration N of M".
ALTER TABLE profiles ADD COLUMN reuse_fix_pod INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pods ADD COLUMN fix_iteration INTEGER NOT NULL DEFAULT 0;
