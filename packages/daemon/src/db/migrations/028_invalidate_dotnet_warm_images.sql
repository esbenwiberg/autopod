-- Force rebuild of dotnet warm images to pick up Azure Artifacts Credential Provider.
-- Setting warm_image_built_at to NULL makes isStale() return true, triggering a rebuild.
UPDATE profiles
SET warm_image_built_at = NULL
WHERE template LIKE 'dotnet%'
  AND warm_image_built_at IS NOT NULL;
