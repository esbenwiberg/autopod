-- Replace the single output_mode enum with orthogonal pod config axes.
-- The legacy column stays for one release as a read-only fallback and will
-- be dropped in a later migration once all consumers are on the new fields.
--
-- sessions table — 4 new columns:
--   agent_mode     auto or interactive
--   output_target  pr, branch, artifact, or none
--   validate       0 or 1 (whether to run full build/smoke/review)
--   promotable     0 or 1 (whether the session can be promoted mid-flight)
--
-- profiles table — same 4 columns, nullable (null = no profile default).

ALTER TABLE sessions ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE sessions ADD COLUMN output_target TEXT NOT NULL DEFAULT 'pr';
ALTER TABLE sessions ADD COLUMN validate INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN promotable INTEGER NOT NULL DEFAULT 0;

ALTER TABLE profiles ADD COLUMN agent_mode TEXT;
ALTER TABLE profiles ADD COLUMN output_target TEXT;
ALTER TABLE profiles ADD COLUMN validate INTEGER;
ALTER TABLE profiles ADD COLUMN promotable INTEGER;

-- Backfill sessions from legacy output_mode.
UPDATE sessions
   SET agent_mode    = 'auto',
       output_target = 'pr',
       validate      = 1,
       promotable    = 0
 WHERE output_mode = 'pr';

UPDATE sessions
   SET agent_mode    = 'auto',
       output_target = 'artifact',
       validate      = 0,
       promotable    = 0
 WHERE output_mode = 'artifact';

UPDATE sessions
   SET agent_mode    = 'interactive',
       output_target = 'branch',
       validate      = 0,
       promotable    = 1
 WHERE output_mode = 'workspace';

-- Backfill profiles from legacy output_mode.
UPDATE profiles
   SET agent_mode    = 'auto',
       output_target = 'pr',
       validate      = 1,
       promotable    = 0
 WHERE output_mode = 'pr';

UPDATE profiles
   SET agent_mode    = 'auto',
       output_target = 'artifact',
       validate      = 0,
       promotable    = 0
 WHERE output_mode = 'artifact';

UPDATE profiles
   SET agent_mode    = 'interactive',
       output_target = 'branch',
       validate      = 0,
       promotable    = 1
 WHERE output_mode = 'workspace';
