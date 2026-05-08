-- Backfill: clear `worktree_compromised` on already-completed pods.
--
-- The flag was sticky for its entire history — only the manual "Recover Worktree"
-- action cleared it. Pods that hit the deletion guard mid-run, then re-spawned on
-- a fresh worktree and completed successfully, kept the flag forever and showed
-- a perpetual orange banner in the desktop UI.
--
-- Going forward, transition() auto-clears the flag on `complete`. This statement
-- unsticks the historical pods that completed before that change shipped.
UPDATE pods
SET worktree_compromised = 0
WHERE status = 'complete'
  AND worktree_compromised = 1;
