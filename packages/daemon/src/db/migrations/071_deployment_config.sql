-- Adds deployment configuration column to profiles.
-- JSON-serialized DeploymentConfig or NULL (feature disabled).
ALTER TABLE profiles ADD COLUMN deployment TEXT;
