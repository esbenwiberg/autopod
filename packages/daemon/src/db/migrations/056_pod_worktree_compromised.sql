-- Set when the auto-commit deletion guard aborts a commit on this pod's worktree.
-- A strong signal that syncWorkspaceBack() failed and the host worktree is missing
-- files while the git index still references them. Desktop uses this to disable
-- Create PR / merge actions and surface a recovery banner.
ALTER TABLE pods ADD COLUMN worktree_compromised INTEGER NOT NULL DEFAULT 0;
