-- Private package registry support (npm / NuGet Azure DevOps feeds)
ALTER TABLE profiles ADD COLUMN private_registries TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN registry_pat TEXT;
