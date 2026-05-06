-- Make reuse_fix_pod nullable so derived profiles can leave it unset
-- (= "inherit from parent") instead of carrying an explicit 0 that
-- silently overrides the parent's true. The previous schema
-- (INTEGER NOT NULL DEFAULT 0) couldn't distinguish "user explicitly
-- disabled" from "default-stored 0 — never touched", so the override
-- card kept reappearing after the user cleared it.
--
-- Existing 0 values become NULL: in practice every 0 in the DB today
-- is the schema default rather than an explicit user choice, because
-- the bug under repair coerced every PATCH back to 0. Profiles that
-- legitimately want reuseFixPod=false can re-toggle the override.
ALTER TABLE profiles RENAME COLUMN reuse_fix_pod TO reuse_fix_pod_legacy;
ALTER TABLE profiles ADD COLUMN reuse_fix_pod INTEGER NULL;
UPDATE profiles SET reuse_fix_pod = CASE WHEN reuse_fix_pod_legacy = 1 THEN 1 ELSE NULL END;
ALTER TABLE profiles DROP COLUMN reuse_fix_pod_legacy;
